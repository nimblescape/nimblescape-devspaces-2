// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, HttpResponse, HttpTransport } from '../http';
import { isAbortError, type RunOptions, type RunResult } from '../ports';
import type { DownloadOptions } from './dockerDownload';
import { LockTimeoutError } from '../storage/lockFolder';
import { WSL_LIST_ARGS } from './dockerHost';
import {
  DOCKER_WAIT_SCRIPT,
  LXSS_KEY,
  PROVISION_SCRIPT,
  WSL_CONF,
  WSL_DISTRIBUTION_LIST_URL,
  WSL_POLICY,
  WSL_POLICY_MARK,
  WSL_TERMINATE_ARGS,
  WSL_UNREGISTER_ARGS,
  WslSetup,
  WslSetupError,
  debianImageOf,
  dockerDesktopIntegrates,
  dockerDesktopSettingsFiles,
  listsDistribution,
  parseLxss,
  distributionFoldersOf,
  parseWslVersion,
  regDeleteDefaultArgs,
  regExportArgs,
  supportsFromFile,
  wslInstallArgs,
  wslSetupFolder,
  type WslSetupStep,
} from './wslSetup';

const WSL = 'C:\\Windows\\System32\\wsl.exe';
const REG = 'C:\\Windows\\System32\\reg.exe';
const SHA = 'ab'.repeat(32);
const DEBIAN_URL = 'https://salsa.debian.org/debian/WSL/-/jobs/1/artifacts/raw/Debian_WSL_AMD64_v1.0.0.0.wsl';
const LIST = {
  ModernDistributions: {
    Debian: [
      {
        Name: 'Debian',
        Default: true,
        Amd64Url: { Url: DEBIAN_URL, Sha256: SHA },
        Arm64Url: { Url: 'https://salsa.debian.org/debian/WSL/-/jobs/1/artifacts/raw/Debian_WSL_ARM64_v1.0.0.0.wsl', Sha256: `0x${'CD'.repeat(32)}` },
      },
    ],
  },
};

const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const failed = (stderr: string, exitCode = 1): RunResult => ({ exitCode, stdout: '', stderr, timedOut: false });
const timedOut: RunResult = { exitCode: null, stdout: '', stderr: '', timedOut: true };
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() });

interface Call {
  file: string;
  args: readonly string[];
  options?: RunOptions;
}

/**
 * The file of `reg.exe export` with the distributions `folders` (name, then BasePath), in UTF-16 with a BOM, as Windows
 * writes it. `states`: the value State of a distribution by its name (none without).
 */
function lxssExport(folders: Record<string, string>, defaultIndex: number | 'none' = 1, states: Record<string, number> = {}): Buffer {
  const key = LXSS_KEY.replace('HKCU', 'HKEY_CURRENT_USER');
  const lines = ['Windows Registry Editor Version 5.00', '', `[${key}]`, ...(defaultIndex === 'none' ? [] : [`"DefaultDistribution"="{${defaultIndex}}"`]), ''];
  Object.entries(folders).forEach(([name, basePath], index) => {
    const escaped = basePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const state = states[name] === undefined ? [] : [`"State"=dword:${states[name].toString(16).padStart(8, '0')}`];
    lines.push(`[${key}\\{${index}}]`, `"BasePath"="${escaped}"`, `"DistributionName"="${name}"`, '"Flags"=dword:0000000f', ...state, '');
  });
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\r\n'), 'utf16le')]);
}

const isRunResult = (value: Record<string, string> | RunResult): value is RunResult => typeof value.timedOut === 'boolean';

/**
 * A runner of `wsl.exe` that answers each call with `answer`; a call that `answer` does not know fails the test.
 * `reg.exe export` writes `registry` (the folders of the distributions by name), or ends with it when it is a result.
 */
function wslRunner(answer: (args: readonly string[], options?: RunOptions) => RunResult | Error | undefined, registry?: Record<string, string> | RunResult) {
  const calls: Call[] = [];
  return {
    calls,
    run: vi.fn(async (file: string, args: readonly string[], options?: RunOptions) => {
      calls.push({ file, args, options });
      if (file === REG && registry !== undefined) {
        if (isRunResult(registry)) return registry;
        fs.writeFileSync(args[2], lxssExport(registry));
        return ok();
      }
      const result = answer(args, options);
      if (result instanceof Error) throw result;
      if (result === undefined) throw new Error(`unexpected wsl.exe ${args.join(' ')}`);
      return result;
    }),
  };
}

/** `runner`, with `reg.exe export` writing `lines` as they are (UTF-8): keys that lxssExport cannot write. */
function withRawRegistry<R extends ReturnType<typeof wslRunner>>(runner: R, lines: string[]): R {
  return {
    ...runner,
    run: vi.fn(async (file: string, args: readonly string[], options?: RunOptions) => {
      if (file !== REG) return runner.run(file, args, options);
      fs.writeFileSync(args[2], Buffer.from(lines.join('\r\n'), 'utf8'));
      return ok();
    }),
  };
}

function http(answers: Record<string, () => Partial<HttpResponse> | Error>): HttpTransport & { requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  return {
    requests,
    request: async (request) => {
      requests.push(request);
      const answer = answers[`${request.method} ${request.url}`]?.();
      if (answer === undefined) throw new Error(`unexpected ${request.method} ${request.url}`);
      if (answer instanceof Error) throw answer;
      return { status: 200, headers: {}, body: '', ...answer };
    },
  };
}

const isScript = (args: readonly string[]) => args.join(' ') === '-d devspaces -u root --cd / --exec sh -s';

let folder: string;

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-wsl-'));
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

function setup(options: {
  runner: ReturnType<typeof wslRunner>;
  http?: HttpTransport;
  download?: (options: DownloadOptions) => Promise<void>;
  arch?: string;
  wslPath?: string | undefined;
  log?: ReturnType<typeof logger>;
  stalledAfterMs?: number;
}): WslSetup {
  return new WslSetup({
    runner: options.runner,
    wslPath: () => ('wslPath' in options ? options.wslPath : WSL),
    env: { PATH: 'C:\\Windows\\System32' },
    arch: options.arch ?? 'x64',
    folder,
    logger: options.log ?? logger(),
    http: options.http ?? http({}),
    download: options.download,
    stalledAfterMs: options.stalledAfterMs,
  });
}

describe('wslSetupFolder', () => {
  it('is a folder of nimblescape in LOCALAPPDATA, also with another case of the name', () => {
    expect(wslSetupFolder({ LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local' })).toBe('C:\\Users\\Ana\\AppData\\Local\\nimblescape\\devspaces\\wsl');
    expect(wslSetupFolder({ LocalAppData: 'D:\\Local' })).toBe('D:\\Local\\nimblescape\\devspaces\\wsl');
    expect(wslSetupFolder({ APPDATA: 'C:\\Roaming' })).toBeUndefined();
    expect(wslSetupFolder({ LOCALAPPDATA: '' })).toBeUndefined();
  });
});

describe('wslInstallArgs', () => {
  it('registers the file under the name devspaces in the folder as WSL 2, without a start', () => {
    expect(wslInstallArgs('C:\\x\\debian.wsl', 'C:\\x\\disk')).toEqual([
      '--install',
      '--from-file',
      'C:\\x\\debian.wsl',
      '--name',
      'devspaces',
      '--location',
      'C:\\x\\disk',
      '--version',
      '2',
      '--no-launch',
    ]);
  });
});

describe('debianImageOf', () => {
  it('takes the Debian file of the architecture, with its SHA-256 in lower case and without 0x', () => {
    expect(debianImageOf(LIST, 'x64')).toEqual({ name: 'Debian', url: DEBIAN_URL, sha256: SHA });
    expect(debianImageOf(LIST, 'arm64')).toEqual({ name: 'Debian', url: LIST.ModernDistributions.Debian[0].Arm64Url.Url, sha256: 'cd'.repeat(32) });
  });

  it('takes the default entry, else the first one', () => {
    const other = { Name: 'Debian-12', Amd64Url: { Url: 'https://example.org/12.wsl', Sha256: SHA } };
    expect(debianImageOf({ ModernDistributions: { Debian: [other, LIST.ModernDistributions.Debian[0]] } }, 'x64')?.url).toBe(DEBIAN_URL);
    expect(debianImageOf({ ModernDistributions: { Debian: [other] } }, 'x64')).toEqual({ name: 'Debian-12', url: 'https://example.org/12.wsl', sha256: SHA });
  });

  it('gives none for another architecture, a list without Debian, a URL that is not HTTPS, or a SHA-256 that is not one', () => {
    expect(debianImageOf(LIST, 'ia32')).toBeUndefined();
    expect(debianImageOf({ ModernDistributions: { Ubuntu: [] } }, 'x64')).toBeUndefined();
    expect(debianImageOf(null, 'x64')).toBeUndefined();
    expect(debianImageOf('text', 'x64')).toBeUndefined();
    const entry = (Url: unknown, Sha256: unknown) => ({ ModernDistributions: { Debian: [{ Name: 'Debian', Amd64Url: { Url, Sha256 } }] } });
    expect(debianImageOf(entry('http://salsa.debian.org/x.wsl', SHA), 'x64')).toBeUndefined();
    expect(debianImageOf(entry('https://salsa.debian.org:8443/x.wsl', SHA), 'x64')).toBeUndefined();
    expect(debianImageOf(entry(DEBIAN_URL, 'ab'.repeat(31)), 'x64')).toBeUndefined();
    expect(debianImageOf(entry(DEBIAN_URL, 42), 'x64')).toBeUndefined();
    expect(debianImageOf(entry(42, SHA), 'x64')).toBeUndefined();
  });
});

describe('the version of WSL', () => {
  it('is read from the first line, also in another language and in UTF-16', () => {
    expect(parseWslVersion('WSL version: 2.4.4.0\r\nKernel version: 5.15.167.4-1\r\n')).toEqual([2, 4, 4]);
    expect(parseWslVersion('WSL-Version: 2.6.1.0\nKernelversion: 6.6.87.2-1\n')).toEqual([2, 6, 1]);
    expect(parseWslVersion('\uFEFFW\0S\0L\0 \0v\0e\0r\0s\0i\0o\0n\0:\0 \x002\0.\x005\0.\x0010\0')).toEqual([2, 5, 10]);
    expect(parseWslVersion('Usage: wsl.exe [Argument]')).toBeUndefined();
  });

  it('can register a file from 2.4.4 on', () => {
    expect(supportsFromFile([2, 4, 4])).toBe(true);
    expect(supportsFromFile([2, 5, 0])).toBe(true);
    expect(supportsFromFile([3, 0, 0])).toBe(true);
    expect(supportsFromFile([2, 4, 3])).toBe(false);
    expect(supportsFromFile([2, 3, 26])).toBe(false);
    expect(supportsFromFile([1, 9, 9])).toBe(false);
  });
});

describe('WslSetup.checkWsl', () => {
  it('gives the version of WSL, with WSL_UTF8=1', async () => {
    const runner = wslRunner((args) => (args[0] === '--version' ? ok('WSL version: 2.6.1.0\n') : undefined));
    await expect(setup({ runner }).checkWsl()).resolves.toBe('2.6.1');
    expect(runner.calls[0].file).toBe(WSL);
    expect(runner.calls[0].options?.env?.WSL_UTF8).toBe('1');
    expect(runner.calls[0].options?.timeoutMs).toBe(15_000);
  });

  it('refuses a WSL older than 2.4.4, also one that knows no --version', async () => {
    const old = wslRunner((args) => (args[0] === '--version' ? ok('WSL version: 2.3.26.0\n') : undefined));
    await expect(setup({ runner: old }).checkWsl()).rejects.toMatchObject({ problem: 'wslTooOld', message: expect.stringContaining('WSL 2.3.26 cannot register a file') });
    const inbox = wslRunner((args) => (args[0] === '--version' ? failed('Invalid command line argument: --version', 4294967295) : ok('Default Version: 2')));
    await expect(setup({ runner: inbox }).checkWsl()).rejects.toMatchObject({ problem: 'wslTooOld' });
  });

  it('says that WSL is missing without wsl.exe, when it cannot start, or when --status fails too', async () => {
    const none = wslRunner(() => undefined);
    await expect(setup({ runner: none, wslPath: undefined }).checkWsl()).rejects.toMatchObject({ problem: 'wslMissing' });
    expect(none.calls).toEqual([]);
    const notStarted = wslRunner(() => Object.assign(new Error('spawn wsl.exe ENOENT'), { code: 'ENOENT' }));
    await expect(setup({ runner: notStarted }).checkWsl()).rejects.toMatchObject({ problem: 'wslMissing' });
    // Another failure of the start is no missing WSL: a removal must not take it for one.
    const denied = wslRunner(() => Object.assign(new Error('spawn wsl.exe EACCES'), { code: 'EACCES' }));
    await expect(setup({ runner: denied }).registration()).rejects.toMatchObject({ problem: 'wslNotAnswering' });
    const stub = wslRunner(() => failed('The Windows Subsystem for Linux is not installed.'));
    await expect(setup({ runner: stub }).checkWsl()).rejects.toMatchObject({
      problem: 'wslMissing',
      message: expect.stringContaining('The Windows Subsystem for Linux is not installed.'),
    });
  });

  it('says that WSL does not answer when a short call ends by its time limit', async () => {
    const runner = wslRunner(() => timedOut);
    await expect(setup({ runner }).checkWsl()).rejects.toMatchObject({ problem: 'wslNotAnswering', message: 'wsl.exe --version did not answer within 15 seconds.' });
  });
});

// Mutation: a list that fails for another reason and counts as one without the distribution fails it (the start entry
// of the distribution would go after a moment of a broken WSL).
describe('listsDistribution', () => {
  const run = (exitCode: number, stdout: string, stderr = ''): RunResult => ({ exitCode, stdout, stderr, timedOut: false });
  it('names the distribution without case; false without it, and when WSL has no distribution; undefined for another failure', () => {
    expect(listsDistribution(run(0, 'Ubuntu\r\nDevspaces\r\n'), 'devspaces')).toBe(true);
    expect(listsDistribution(run(0, 'Ubuntu\r\n'), 'devspaces')).toBe(false);
    expect(listsDistribution(run(1, 'Fehlercode: Wsl/WSL_E_DEFAULT_DISTRO_NOT_FOUND'), 'devspaces')).toBe(false);
    expect(listsDistribution(run(1, '', 'Error code: Wsl/Service/E_UNEXPECTED'), 'devspaces')).toBeUndefined();
  });
});

describe('WslSetup.registration', () => {
  it('is none without a distribution of that name, also when WSL lists none with an exit code', async () => {
    const noList = () => failed('Windows Subsystem for Linux has no installed distributions.', 4294967295);
    const empty = wslRunner(noList, failed('ERROR: The system was unable to find the specified registry key or value.'));
    await expect(setup({ runner: empty }).registration()).resolves.toBe('none');
    expect(empty.calls[0].args).toEqual(WSL_LIST_ARGS);
    await expect(setup({ runner: wslRunner(noList, { Ubuntu: 'C:\\WSL\\Ubuntu' }) }).registration()).resolves.toBe('none');
    // The code of WSL without any distribution needs no registry, in any language.
    const none = wslRunner(() => failed('Das Windows-Subsystem für Linux verfügt über keine installierten Distributionen.\r\nFehlercode: Wsl/WSL_E_DEFAULT_DISTRO_NOT_FOUND', 4294967295));
    await expect(setup({ runner: none }).registration()).resolves.toBe('none');
    expect(none.calls).toHaveLength(1);
    // A list without it needs no registry.
    const others = wslRunner(() => ok('Ubuntu\r\ndocker-desktop\r\n'));
    await expect(setup({ runner: others }).registration()).resolves.toBe('none');
    expect(others.calls).toHaveLength(1);
  });

  it('takes the registry when the list of WSL fails, so that a failed list does not hide the distribution', async () => {
    const runner = wslRunner(() => failed('Wsl/Service/E_UNEXPECTED'), { devspaces: path.join(folder, 'disk') });
    await expect(setup({ runner }).registration()).resolves.toBe('own');
  });

  it('is own when the registry names the folder of Devspaces for its virtual disk, else foreign (names without case)', async () => {
    const list = () => ok('Ubuntu\r\nDevspaces\r\n');
    const disk = path.join(folder, 'disk');
    const own = wslRunner(list, { Ubuntu: 'C:\\WSL\\Ubuntu', Devspaces: `\\\\?\\${disk.toUpperCase()}\\` });
    await expect(setup({ runner: own }).registration()).resolves.toBe('own');
    const reg = own.calls.find((call) => call.file === REG);
    expect(reg?.args).toEqual(regExportArgs(reg?.args[2] ?? ''));
    expect(reg?.args[2].startsWith(os.tmpdir())).toBe(true);
    // The export is removed after the read, and nothing is written to the folder of Devspaces.
    expect(fs.existsSync(path.dirname(reg?.args[2] ?? ''))).toBe(false);
    expect(fs.readdirSync(folder)).toEqual([]);
    // A distribution of the user with that name, also with a virtual disk in the folder of Devspaces.
    fs.mkdirSync(disk);
    fs.writeFileSync(path.join(disk, 'ext4.vhdx'), '');
    await expect(setup({ runner: wslRunner(list, { devspaces: 'D:\\mine' }) }).registration()).resolves.toBe('foreign');
    await expect(setup({ runner: wslRunner(list, { Ubuntu: disk }) }).registration()).resolves.toBe('foreign');
    // The disk of a later registration may be in another folder of Devspaces.
    await expect(setup({ runner: wslRunner(list, { devspaces: path.join(folder, 'disk-2') }) }).registration()).resolves.toBe('own');
    // The registry may name the folder in another form: through a link (or a junction, or a short name on Windows).
    const link = `${folder}-link`;
    fs.symlinkSync(folder, link);
    try {
      await expect(setup({ runner: wslRunner(list, { devspaces: path.join(link, 'disk') }) }).registration()).resolves.toBe('own');
    } finally {
      fs.rmSync(link);
    }
  });

  it('never guesses the owner when WSL lists the distribution but the registry cannot be read', async () => {
    const log = logger();
    fs.mkdirSync(path.join(folder, 'disk'));
    fs.writeFileSync(path.join(folder, 'disk', 'ext4.vhdx'), '');
    const runner = wslRunner(() => ok('devspaces\r\n'), failed('ERROR: Registry editing has been disabled by your administrator.'));
    await expect(setup({ runner, log }).registration()).rejects.toMatchObject({ problem: 'registryFailed' });
    expect(log.warn).toHaveBeenCalledWith(
      `The WSL distributions could not be read from the registry (${LXSS_KEY}): reg.exe export ended with exit code 1: ERROR: Registry editing has been disabled by your administrator.`,
    );
  });

  it('is sure for a removal: it tells neither none nor own when neither the list nor the registry can be read', async () => {
    const runner = wslRunner((args) => (args[0] === '--version' ? ok('WSL version: 2.6.1.0') : failed('Wsl/Service/E_UNEXPECTED')), failed('ERROR: Access is denied.'));
    await expect(setup({ runner }).registration()).resolves.toBe('none');
    await expect(setup({ runner }).registration(undefined, true)).rejects.toMatchObject({ problem: 'registryFailed' });
    // Without WSL (the wsl.exe of Windows that only offers the installation), there is no distribution.
    const stub = wslRunner(() => failed('The Windows Subsystem for Linux is not installed.'), failed('ERROR: The system was unable to find the specified registry key or value.'));
    await expect(setup({ runner: stub }).registration(undefined, true)).resolves.toBe('none');
    expect(stub.calls.filter((call) => call.file === WSL).map((call) => call.args)).toEqual([WSL_LIST_ARGS, ['--version'], ['--status']]);
    // Without any distribution, WSL tells it by its code.
    const none = wslRunner(() => failed('Error code: Wsl/WSL_E_DEFAULT_DISTRO_NOT_FOUND', 4294967295), failed('ERROR: Access is denied.'));
    await expect(setup({ runner: none }).registration(undefined, true)).resolves.toBe('none');
  });

  it('is foreign when the registry does not tell the folder of the distribution', async () => {
    const runner = withRawRegistry(wslRunner(() => ok('devspaces\r\n')), ['[HKEY_CURRENT_USER\\Lxss\\{1}]', '"DistributionName"="devspaces"']);
    await expect(setup({ runner }).registration()).resolves.toBe('foreign');
  });

  it('says that WSL does not answer instead of none when the list ends by its time limit', async () => {
    const runner = wslRunner(() => timedOut);
    await expect(setup({ runner }).registration()).rejects.toMatchObject({ problem: 'wslNotAnswering' });
  });
});

describe('the registry of the WSL distributions', () => {
  it('gives the distributions in their order with their keys, and the key of the default one', () => {
    const registry = parseLxss(lxssExport({ Ubuntu: 'C:\\u', devspaces: 'C:\\d' }));
    expect(registry).toEqual({
      defaultId: '{1}',
      distributions: [
        { id: '{0}', name: 'Ubuntu', basePath: 'C:\\u', installed: undefined },
        { id: '{1}', name: 'devspaces', basePath: 'C:\\d', installed: undefined },
      ],
    });
    const key = LXSS_KEY.replace('HKCU', 'HKEY_CURRENT_USER');
    const noDefault = [`[${key}]`, '"DefaultVersion"=dword:00000002', '', `[${key}\\{0ABC}]`, '"DistributionName"="Debian"'].join('\r\n');
    expect(parseLxss(Buffer.from(noDefault, 'utf8'))).toEqual({ defaultId: undefined, distributions: [{ id: '{0abc}', name: 'Debian', basePath: undefined, installed: undefined }] });
  });

  it('tells whether each distribution is installed (State 1), and nothing without a State', () => {
    const registry = parseLxss(lxssExport({ Ubuntu: 'C:\\u', Debian: 'C:\\d', Alpine: 'C:\\a' }, 0, { Ubuntu: 1, Debian: 3 }));
    expect(registry.distributions.map((distribution) => distribution.installed)).toEqual([true, false, undefined]);
  });

  it('gives the folder of each distribution by its name, from UTF-16 or UTF-8', () => {
    const exported = lxssExport({ Ubuntu: 'C:\\Users\\ana\\WSL "x"', Devspaces: 'C:\\Users\\ana\\AppData\\Local\\nimblescape\\devspaces\\wsl\\disk' });
    const expected = new Map([
      ['ubuntu', 'C:\\Users\\ana\\WSL "x"'],
      ['devspaces', 'C:\\Users\\ana\\AppData\\Local\\nimblescape\\devspaces\\wsl\\disk'],
    ]);
    expect(distributionFoldersOf(parseLxss(exported))).toEqual(expected);
    expect(distributionFoldersOf(parseLxss(Buffer.from(exported.subarray(2).toString('utf16le'), 'utf8')))).toEqual(expected);
  });

  it('skips a key without a name, and gives no folder for a name without a plain one', () => {
    const text = [
      '[HKEY_CURRENT_USER\\Lxss\\{1}]',
      '"DistributionName"="docker-desktop"',
      '',
      '[HKEY_CURRENT_USER\\Lxss\\{2}]',
      '"BasePath"="C:\\\\x"',
      '',
      '[HKEY_CURRENT_USER\\Lxss\\{3}]',
      '"BasePath"=hex(2):43,00,3a,00,00,00',
      '"DistributionName"="Other"',
    ].join('\r\n');
    expect(distributionFoldersOf(parseLxss(Buffer.from(text, 'utf8')))).toEqual(new Map([['docker-desktop', undefined], ['other', undefined]]));
  });
});

describe('WslSetup.separate', () => {
  /** A runner of `wsl.exe` whose `wsl --set-default <name>` ends with `setDefault(name)`. */
  function registryRunner(setDefault: (name: string) => RunResult = () => ok()) {
    return wslRunner((args) => (args[0] === '--set-default' ? setDefault(args[1]) : undefined));
  }

  /**
   * `runner`, with `reg.exe export` writing `folders` with the default `defaultIndex` and the values State `states`, and
   * any other `reg.exe` ending with `regResult`.
   */
  function withRegistry(
    runner: ReturnType<typeof wslRunner>,
    folders: Record<string, string>,
    defaultIndex: number | 'none',
    states: Record<string, number> = {},
    regResult: RunResult = ok(),
  ) {
    return {
      ...runner,
      run: vi.fn(async (file: string, args: readonly string[], options?: RunOptions) => {
        if (file === REG && args[0] === 'export') {
          runner.calls.push({ file, args, options });
          fs.writeFileSync(args[2], lxssExport(folders, defaultIndex, states));
          return ok();
        }
        if (file === REG) {
          runner.calls.push({ file, args, options });
          return regResult;
        }
        return runner.run(file, args, options);
      }),
    };
  }

  const ours = () => path.join(folder, 'disk');

  // Mutation: a check without the default fails it (`wsl` in a terminal would open the distribution of Devspaces as
  // root, and Docker Desktop would integrate it); so does a default of Docker Desktop, or a change of a distribution
  // that Devspaces did not set up.
  it('makes the first other distribution of the user the default when WSL made the one of Devspaces the default', async () => {
    const base = registryRunner();
    const runner = withRegistry(base, { 'docker-desktop': 'C:\\dd', Ubuntu: 'C:\\u', devspaces: ours() }, 2);
    const log = logger();
    await expect(setup({ runner, log }).separate()).resolves.toBe('separate');
    expect(base.calls.map((call) => call.args)).toEqual([expect.arrayContaining(['export']), ['--set-default', 'Ubuntu']]);
    expect(log.info).toHaveBeenCalledWith('The WSL distribution devspaces of Devspaces was the default distribution of WSL; now Ubuntu is.');
  });

  // Mutation: a stop after the first failure, or a try of a distribution that is not installed (WSL refuses it), fails it.
  it('skips a distribution that is not installed, and tries the next one after a failure', async () => {
    const base = registryRunner((name) => (name === 'Debian' ? failed('Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND') : ok()));
    const folders = { Alpine: 'C:\\a', Debian: 'C:\\d', devspaces: ours(), Ubuntu: 'C:\\u' };
    const log = logger();
    await expect(setup({ runner: withRegistry(base, folders, 2, { Alpine: 3, Debian: 1 }), log }).separate()).resolves.toBe('separate');
    expect(base.calls.map((call) => call.args).slice(1)).toEqual([
      ['--set-default', 'Debian'],
      ['--set-default', 'Ubuntu'],
    ]);
    expect(log.info).toHaveBeenCalledWith('The WSL distribution devspaces of Devspaces was the default distribution of WSL; now Ubuntu is.');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('removes the default of WSL when no other distribution of the user is there', async () => {
    const base = registryRunner();
    const runner = withRegistry(base, { 'docker-desktop': 'C:\\dd', 'docker-desktop-data': 'C:\\ddd', devspaces: ours() }, 2);
    await expect(setup({ runner }).separate()).resolves.toBe('separate');
    expect(base.calls.map((call) => call.args)).toEqual([expect.arrayContaining(['export']), regDeleteDefaultArgs()]);
    expect(regDeleteDefaultArgs()).toEqual(['delete', LXSS_KEY, '/v', 'DefaultDistribution', '/f']);
  });

  it('changes nothing when another distribution is the default, or for a distribution that Devspaces did not set up', async () => {
    const base = registryRunner();
    await expect(setup({ runner: withRegistry(base, { Ubuntu: 'C:\\u', devspaces: ours() }, 0) }).separate()).resolves.toBe('separate');
    await expect(setup({ runner: withRegistry(base, { Ubuntu: 'C:\\u', devspaces: ours() }, 'none') }).separate()).resolves.toBe('separate');
    await expect(setup({ runner: withRegistry(base, { Ubuntu: 'C:\\u', devspaces: 'C:\\WSL\\devspaces' }, 1) }).separate()).resolves.toBe('none');
    await expect(setup({ runner: withRegistry(base, { Ubuntu: 'C:\\u' }, 0) }).separate()).resolves.toBe('none');
    expect(base.calls.map((call) => call.args[0])).toEqual(['export', 'export', 'export', 'export']);
  });

  it('runs nothing without the folder of Devspaces, and logs a failure without a throw', async () => {
    const base = registryRunner(() => failed('Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND'));
    const log = logger();
    await expect(setup({ runner: withRegistry(base, { Ubuntu: 'C:\\u', devspaces: ours() }, 1), log }).separate()).resolves.toBe('default');
    expect(log.warn).toHaveBeenCalledWith(
      'The WSL distribution devspaces of Devspaces stays the default distribution of WSL: wsl.exe --set-default Ubuntu ended with exit code 1: Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND',
    );
    const reg = registryRunner();
    const regLog = logger();
    await expect(setup({ runner: withRegistry(reg, { devspaces: ours() }, 0, {}, failed('ERROR: Access is denied.')), log: regLog }).separate()).resolves.toBe('default');
    expect(regLog.warn).toHaveBeenCalledWith('The WSL distribution devspaces of Devspaces stays the default distribution of WSL: reg.exe delete ended with exit code 1: ERROR: Access is denied.');
    fs.rmSync(folder, { recursive: true, force: true });
    const none = registryRunner();
    await expect(setup({ runner: withRegistry(none, { devspaces: ours() }, 0) }).separate()).resolves.toBe('none');
    expect(none.calls).toEqual([]);
  });

  it('tells when the registry cannot be read', async () => {
    const runner = wslRunner(() => undefined, failed('ERROR: The system was unable to find the specified registry key or value.'));
    await expect(setup({ runner }).separate()).resolves.toBe('unknown');
  });

  // Mutation: a swallowed abort fails it (the setup must end as cancelled).
  it('throws an AbortError when the signal aborts', async () => {
    const controller = new AbortController();
    const base = registryRunner(() => {
      controller.abort();
      throw new Error('killed');
    });
    await expect(setup({ runner: withRegistry(base, { Ubuntu: 'C:\\u', devspaces: ours() }, 1) }).separate(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('dockerDesktopIntegrates', () => {
  const env = { APPDATA: 'C:\\Users\\ana\\AppData\\Roaming' };
  const files = (content: Record<string, string>) => async (file: string) => {
    const text = content[path.win32.basename(file)];
    if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return text;
  };

  it('reads the list of the WSL integration of Docker Desktop, keys and names without case', async () => {
    expect(dockerDesktopSettingsFiles(env)).toEqual([
      'C:\\Users\\ana\\AppData\\Roaming\\Docker\\settings-store.json',
      'C:\\Users\\ana\\AppData\\Roaming\\Docker\\settings.json',
    ]);
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({ 'settings-store.json': '{"IntegratedWslDistros":["Ubuntu","Devspaces"]}' }))).toBe(true);
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({ 'settings.json': '{"integratedWslDistros":["devspaces"]}' }))).toBe(true);
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({ 'settings-store.json': '{"IntegratedWslDistros":["Ubuntu"],"EnableIntegrationWithDefaultWslDistro":true}' }))).toBe(false);
  });

  // Mutation: a check of the default integration also when the distribution is not the default, or without its default
  // (on), fails it.
  it('counts the integration with the default distribution of WSL only while the distribution is that default', async () => {
    expect(await dockerDesktopIntegrates(env, 'devspaces', true, files({ 'settings-store.json': '{"IntegratedWslDistros":["Ubuntu"]}' }))).toBe(true);
    expect(await dockerDesktopIntegrates(env, 'devspaces', true, files({ 'settings-store.json': '{"enableIntegrationWithDefaultWslDistro":false}' }))).toBe(false);
    expect(await dockerDesktopIntegrates(env, 'devspaces', true, files({}))).toBe(false);
  });

  // Mutation: a check of both files fails it (the file of an older version may stay after the move to settings-store.json).
  it('reads only the first file that is an object', async () => {
    const stale = '{"IntegratedWslDistros":["devspaces"]}';
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({ 'settings-store.json': '{"IntegratedWslDistros":[]}', 'settings.json': stale }))).toBe(false);
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({ 'settings-store.json': '[]', 'settings.json': stale }))).toBe(true);
  });

  it('is false without a file, with a file that is not JSON or has no list, and without APPDATA', async () => {
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({}))).toBe(false);
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({ 'settings-store.json': '{', 'settings.json': '[]' }))).toBe(false);
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({ 'settings-store.json': '{"IntegratedWslDistros":"devspaces"}' }))).toBe(false);
    expect(await dockerDesktopIntegrates({}, 'devspaces', true, files({ 'settings-store.json': '{"IntegratedWslDistros":["devspaces"]}' }))).toBe(false);
  });
});

describe('WslSetup.image', () => {
  it('loads the list of WSL and gives the Debian file with the size of a HEAD request after its redirect', async () => {
    const storage = 'https://storage.example.org/Debian.wsl';
    const transport = http({
      [`GET ${WSL_DISTRIBUTION_LIST_URL}`]: () => ({ body: JSON.stringify(LIST) }),
      [`HEAD ${DEBIAN_URL}`]: () => ({ status: 302, headers: { location: storage } }),
      [`HEAD ${storage}`]: () => ({ headers: { 'content-length': '123456789' } }),
    });
    await expect(setup({ runner: wslRunner(() => undefined), http: transport }).image()).resolves.toEqual({ name: 'Debian', url: DEBIAN_URL, sha256: SHA, size: 123456789 });
    expect(transport.requests[0]).toMatchObject({ method: 'GET', maxBodyBytes: 1024 * 1024 });
  });

  it('gives the file without a size when the HEAD request fails or names none, or a redirect leaves HTTPS', async () => {
    for (const head of [() => new Error('ECONNRESET'), () => ({}), () => ({ status: 302, headers: { location: 'http://storage.example.org/x' } })]) {
      const transport = http({ [`GET ${WSL_DISTRIBUTION_LIST_URL}`]: () => ({ body: JSON.stringify(LIST) }), [`HEAD ${DEBIAN_URL}`]: head });
      await expect(setup({ runner: wslRunner(() => undefined), http: transport }).image()).resolves.toEqual({ name: 'Debian', url: DEBIAN_URL, sha256: SHA });
    }
  });

  it('fails with listFailed on an HTTP error, a list that is not JSON, or no connection, and with noImage for another architecture', async () => {
    for (const answer of [() => ({ status: 404 }), () => ({ body: '<html>' }), () => new Error('getaddrinfo ENOTFOUND')]) {
      const transport = http({ [`GET ${WSL_DISTRIBUTION_LIST_URL}`]: answer });
      await expect(setup({ runner: wslRunner(() => undefined), http: transport }).image()).rejects.toMatchObject({ problem: 'listFailed' });
    }
    const transport = http({ [`GET ${WSL_DISTRIBUTION_LIST_URL}`]: () => ({ body: JSON.stringify(LIST) }) });
    await expect(setup({ runner: wslRunner(() => undefined), http: transport, arch: 'ia32' }).image()).rejects.toMatchObject({
      problem: 'noImage',
      message: 'The list of WSL distributions has no Debian file for ia32.',
    });
  });

  it('is cancelled with the signal', async () => {
    const abort = new AbortController();
    const transport = http({
      [`GET ${WSL_DISTRIBUTION_LIST_URL}`]: () => {
        abort.abort();
        return new Error('aborted');
      },
    });
    const error = await setup({ runner: wslRunner(() => undefined), http: transport }).image(abort.signal).catch((caught: unknown) => caught);
    expect(isAbortError(error)).toBe(true);
  });
});

describe('WslSetup.setUp', () => {
  const image = { name: 'Debian', url: DEBIAN_URL, sha256: SHA, size: 10 };

  /** A distribution that answers each step; `override` changes the answer of one; `registry` as in wslRunner. */
  function distribution(override: (args: readonly string[], options?: RunOptions) => RunResult | Error | undefined = () => undefined, registry?: Record<string, string> | RunResult) {
    return wslRunner((args, options) => {
      const own = override(args, options);
      if (own !== undefined) return own;
      if (args[0] === '--install') return ok('The operation completed successfully.');
      if (isScript(args) && options?.input === PROVISION_SCRIPT) {
        // The lines of the steps arrive in pieces.
        options.onStdout?.('devspaces-step pack');
        options.onStdout?.('ages\ndevspaces-step repository\r\ndevspaces-step unknown\n');
        options.onStdout?.('devspaces-step docker\n');
        return ok();
      }
      if (args.join(' ') === WSL_TERMINATE_ARGS.join(' ')) return ok();
      if (isScript(args) && options?.input === DOCKER_WAIT_SCRIPT) return ok('29.9.2\n');
      return undefined;
    }, registry);
  }

  /** The calls of `wsl.exe` of `runner`, without those of `reg.exe`. */
  const wslCalls = (runner: { calls: Call[] }) => runner.calls.filter((call) => call.file === WSL);

  function writingDownload() {
    return vi.fn(async (options: DownloadOptions) => {
      options.onProgress?.(10, 10);
      fs.writeFileSync(options.target, 'distribution');
    });
  }

  it('downloads, registers, installs Docker, restarts, and checks Docker, in this order', async () => {
    const runner = distribution();
    const download = writingDownload();
    const steps: WslSetupStep[] = [];
    await expect(setup({ runner, download }).setUp(image, (step) => steps.push(step))).resolves.toBe('29.9.2');
    const file = path.join(folder, 'download', 'debian.wsl');
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({ url: DEBIAN_URL, host: 'salsa.debian.org', expected: { sha256: SHA }, anyHttpsRedirect: true, target: file }),
    );
    // After the registration, the registry tells whether WSL made the new distribution its default (WslSetup.separate).
    expect(runner.calls.map((call) => (call.file === REG ? call.args[0] : call.args))).toEqual([
      wslInstallArgs(file, path.join(folder, 'disk')),
      'export',
      ['-d', 'devspaces', '-u', 'root', '--cd', '/', '--exec', 'sh', '-s'],
      WSL_TERMINATE_ARGS,
      ['-d', 'devspaces', '-u', 'root', '--cd', '/', '--exec', 'sh', '-s'],
    ]);
    expect(runner.calls[0].args.join(' ')).toContain('--version 2 --no-launch');
    expect(runner.calls.filter((call) => call.file === WSL).every((call) => call.options?.env?.WSL_UTF8 === '1')).toBe(true);
    expect(steps).toEqual([
      { kind: 'download', received: 0, total: 10 },
      { kind: 'download', received: 10, total: 10 },
      { kind: 'register' },
      { kind: 'docker', phase: 'packages' },
      { kind: 'docker', phase: 'repository' },
      { kind: 'docker', phase: 'docker' },
      { kind: 'restart' },
      { kind: 'start' },
    ]);
    // The download is gone after the registration; the folder of the disk stays.
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(folder, 'disk'))).toBe(true);
  });

  it('runs only the script, the restart, and the check without a file', async () => {
    const runner = distribution();
    const download = writingDownload();
    await expect(setup({ runner, download }).setUp(undefined, () => undefined)).resolves.toBe('29.9.2');
    expect(download).not.toHaveBeenCalled();
    expect(wslCalls(runner).map((call) => call.args[0])).toEqual(['-d', '--terminate', '-d']);
    // Also a setup again keeps the distribution off the default of WSL (WslSetup.separate).
    expect(runner.calls.filter((call) => call.file === REG).map((call) => call.args[0])).toEqual(['export']);
  });

  it('fails with downloadFailed and registers nothing when the download fails', async () => {
    const runner = distribution();
    const download = vi.fn(async (options: DownloadOptions) => {
      fs.writeFileSync(options.target, 'part');
      throw new Error('The download of x is not the file of its pin');
    });
    await expect(setup({ runner, download }).setUp(image, () => undefined)).rejects.toMatchObject({
      problem: 'downloadFailed',
      message: `The Debian file for WSL could not be downloaded from ${DEBIAN_URL}: The download of x is not the file of its pin`,
    });
    expect(runner.calls).toEqual([]);
    expect(fs.existsSync(path.join(folder, 'download', 'debian.wsl'))).toBe(false);
  });

  it('stops a download that receives no bytes', async () => {
    const download = vi.fn((options: DownloadOptions) => new Promise<void>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    await expect(setup({ runner: distribution(), download, stalledAfterMs: 20 }).setUp(image, () => undefined)).rejects.toMatchObject({
      problem: 'downloadFailed',
      message: expect.stringContaining('it received no bytes for 0 seconds'),
    });
  });

  it('is cancelled with the signal during the download, and removes the download', async () => {
    const abort = new AbortController();
    const download = vi.fn(async (options: DownloadOptions) => {
      fs.writeFileSync(options.target, 'part');
      abort.abort();
      throw new Error('aborted');
    });
    const error = await setup({ runner: distribution(), download }).setUp(image, () => undefined, abort.signal).catch((caught: unknown) => caught);
    expect(isAbortError(error)).toBe(true);
    expect(fs.existsSync(path.join(folder, 'download', 'debian.wsl'))).toBe(false);
  });

  it('ends the registration after a cancel, and then stops before the script', async () => {
    const abort = new AbortController();
    const runner = distribution((args) => {
      if (args[0] !== '--install') return undefined;
      abort.abort();
      return ok();
    });
    const error = await setup({ runner, download: writingDownload() }).setUp(image, () => undefined, abort.signal).catch((caught: unknown) => caught);
    expect(isAbortError(error)).toBe(true);
    expect(runner.calls.map((call) => call.args[0])).toEqual(['--install']);
    expect(runner.calls[0].options?.signal).toBeUndefined();
    expect(fs.existsSync(path.join(folder, 'download', 'debian.wsl'))).toBe(false);
  });

  it('fails with registerFailed with the message of WSL, and removes the download', async () => {
    const runner = distribution((args) => (args[0] === '--install' ? failed('W\0S\0L\0_\0E\0_\0D\0I\0S\0T\0R\0O\0_\0E\0X\0I\0S\0T\0S\0') : undefined));
    await expect(setup({ runner, download: writingDownload() }).setUp(image, () => undefined)).rejects.toMatchObject({
      problem: 'registerFailed',
      message: 'wsl.exe --install --from-file failed (exit code 1): WSL_E_DISTRO_EXISTS',
    });
    expect(runner.calls).toHaveLength(1);
    expect(fs.existsSync(path.join(folder, 'download', 'debian.wsl'))).toBe(false);
  });

  it('fails with dockerFailed and the lines of the log that the script wrote to standard error', async () => {
    const runner = distribution((args, options) =>
      isScript(args) && options?.input === PROVISION_SCRIPT ? failed('The setup failed. The last lines of /var/log/devspaces-setup.log:\nE: Unable to locate package curl', 1) : undefined,
    );
    await expect(setup({ runner }).setUp(undefined, () => undefined)).rejects.toMatchObject({
      problem: 'dockerFailed',
      message: expect.stringContaining('(exit code 1): The setup failed. The last lines of /var/log/devspaces-setup.log:\nE: Unable to locate package curl'),
    });
    expect(wslCalls(runner)).toHaveLength(1);
  });

  it('names the time limit of a script that does not end, and stops the distribution so that the script ends', async () => {
    const log = logger();
    const runner = distribution((args, options) => (isScript(args) && options?.input === PROVISION_SCRIPT ? timedOut : undefined));
    await expect(setup({ runner, log }).setUp(undefined, () => undefined)).rejects.toMatchObject({
      problem: 'dockerFailed',
      message: expect.stringContaining('(no end within 30 minutes): (no output)'),
    });
    expect(wslCalls(runner)[0].options?.timeoutMs).toBe(30 * 60_000);
    expect(wslCalls(runner).map((call) => call.args[0])).toEqual(['-d', '--terminate']);
    expect(log.info).toHaveBeenCalledWith('The WSL distribution devspaces was stopped: the script did not end within 30 minutes.');
  });

  it('stops the distribution when the script is cancelled, so that it does not go on there', async () => {
    const abort = new AbortController();
    const runner = distribution((args, options) => {
      if (!isScript(args) || options?.input !== PROVISION_SCRIPT) return undefined;
      abort.abort();
      return new Error('The operation was aborted');
    });
    const error = await setup({ runner }).setUp(undefined, () => undefined, abort.signal).catch((caught: unknown) => caught);
    expect(isAbortError(error)).toBe(true);
    expect(wslCalls(runner).map((call) => call.args)).toEqual([['-d', 'devspaces', '-u', 'root', '--cd', '/', '--exec', 'sh', '-s'], WSL_TERMINATE_ARGS]);
    // The stop itself is not cancelled.
    expect(wslCalls(runner)[1].options?.signal).toBeUndefined();
  });

  it('removes the virtual disk of a setup that did not end before it registers the file again', async () => {
    const disk = path.join(folder, 'disk');
    fs.mkdirSync(disk, { recursive: true });
    fs.writeFileSync(path.join(disk, 'ext4.vhdx'), 'old');
    const log = logger();
    const runner = distribution(undefined, { Ubuntu: 'C:\\WSL\\Ubuntu' });
    await expect(setup({ runner, download: writingDownload(), log }).setUp(image, () => undefined)).resolves.toBe('29.9.2');
    expect(runner.calls.map((call) => call.file)).toEqual([REG, WSL, REG, WSL, WSL, WSL]);
    expect(fs.readdirSync(disk)).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(`The folder ${disk} has the files of a setup that did not end (ext4.vhdx); they are removed.`);
  });

  it('registers in another folder and removes nothing when a distribution uses the disk, or when nothing tells', async () => {
    const disk = path.join(folder, 'disk');
    fs.mkdirSync(disk, { recursive: true });
    fs.writeFileSync(path.join(disk, 'ext4.vhdx'), 'in use');
    const log = logger();
    const used = distribution(undefined, { other: disk });
    await expect(setup({ runner: used, download: writingDownload(), log }).setUp(image, () => undefined)).resolves.toBe('29.9.2');
    const file = path.join(folder, 'download', 'debian.wsl');
    expect(used.calls.find((call) => call.args[0] === '--install')?.args).toEqual(wslInstallArgs(file, path.join(folder, 'disk-2')));
    expect(log.info).toHaveBeenCalledWith(
      `The folder ${disk} has files (ext4.vhdx), and the WSL distribution other has its virtual disk there; the new distribution gets the folder ${path.join(folder, 'disk-2')}.`,
    );
    // Without the registry and the list of WSL, the next free folder.
    fs.writeFileSync(path.join(folder, 'disk-2', 'ext4.vhdx'), 'of the first one');
    const unknown = distribution(undefined, failed('Access is denied.'));
    await setup({ runner: unknown, download: writingDownload() }).setUp(image, () => undefined);
    expect(unknown.calls.find((call) => call.args[0] === '--install')?.args).toEqual(wslInstallArgs(file, path.join(folder, 'disk-3')));
    expect(fs.readdirSync(disk)).toEqual(['ext4.vhdx']);
    expect(fs.readdirSync(path.join(folder, 'disk-2'))).toEqual(['ext4.vhdx']);
  });

  it('keeps a disk folder that a known distribution uses, or that cannot be read', async () => {
    const disk = path.join(folder, 'disk');
    fs.mkdirSync(disk, { recursive: true });
    fs.writeFileSync(path.join(disk, 'ext4.vhdx'), 'in use');
    const file = path.join(folder, 'download', 'debian.wsl');
    const installArgs = (runner: ReturnType<typeof wslRunner>) => runner.calls.find((call) => call.args[0] === '--install')?.args;
    // A distribution with its disk there, next to one whose folder the registry does not tell.
    const mixed = withRawRegistry(distribution(), [
      '[HKEY_CURRENT_USER\\Lxss\\{1}]',
      `"BasePath"="${disk.replace(/\\/g, '\\\\')}"`,
      '"DistributionName"="other"',
      '',
      '[HKEY_CURRENT_USER\\Lxss\\{2}]',
      '"BasePath"=hex(2):43,00',
      '"DistributionName"="third"',
    ]);
    await setup({ runner: mixed, download: writingDownload() }).setUp(image, () => undefined);
    expect(installArgs(mixed)).toEqual(wslInstallArgs(file, path.join(folder, 'disk-2')));
    expect(fs.readdirSync(disk)).toEqual(['ext4.vhdx']);
    // A file in place of the folder.
    fs.rmSync(folder, { recursive: true });
    fs.mkdirSync(folder);
    fs.writeFileSync(disk, 'not a folder');
    const plain = distribution(undefined, { Ubuntu: 'C:\\WSL\\Ubuntu' });
    await setup({ runner: plain, download: writingDownload() }).setUp(image, () => undefined);
    expect(installArgs(plain)).toEqual(wslInstallArgs(file, path.join(folder, 'disk-2')));
    expect(fs.readFileSync(disk, 'utf8')).toBe('not a folder');
  });

  it('registers in another folder when the files of a setup that did not end cannot be removed', async () => {
    const disk = path.join(folder, 'disk');
    fs.mkdirSync(disk, { recursive: true });
    fs.writeFileSync(path.join(disk, 'ext4.vhdx'), 'open');
    const rm = fs.promises.rm;
    const spy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      if (target === disk) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return rm(target, options);
    });
    try {
      const runner = distribution(undefined, { Ubuntu: 'C:\\WSL\\Ubuntu' });
      const log = logger();
      await setup({ runner, download: writingDownload(), log }).setUp(image, () => undefined);
      const file = path.join(folder, 'download', 'debian.wsl');
      expect(runner.calls.find((call) => call.args[0] === '--install')?.args).toEqual(wslInstallArgs(file, path.join(folder, 'disk-2')));
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('and they could not be removed (EBUSY: resource busy or locked)'));
    } finally {
      spy.mockRestore();
    }
  });

  it('removes a download that stayed after a registration when it sets up the distribution again', async () => {
    fs.mkdirSync(path.join(folder, 'download'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'download', 'debian.wsl'), 'kept');
    await setup({ runner: distribution() }).setUp(undefined, () => undefined);
    expect(fs.existsSync(path.join(folder, 'download'))).toBe(false);
  });

  it('removes the virtual disk of a setup that did not end without the registry when WSL does not list the distribution', async () => {
    const disk = path.join(folder, 'disk');
    fs.mkdirSync(disk, { recursive: true });
    fs.writeFileSync(path.join(disk, 'ext4.vhdx'), 'old');
    const runner = distribution((args) => (args.join(' ') === WSL_LIST_ARGS.join(' ') ? ok('Ubuntu\r\n') : undefined), failed('Access is denied.'));
    await expect(setup({ runner, download: writingDownload() }).setUp(image, () => undefined)).resolves.toBe('29.9.2');
    expect(fs.readdirSync(disk)).toEqual([]);
  });

  it('limits the size of the download', async () => {
    const download = writingDownload();
    await setup({ runner: distribution(), download }).setUp(image, () => undefined);
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 2 * 1024 * 1024 * 1024 }));
  });

  it('goes on after a failed restart (logged), and fails with dockerNotRunning when Docker does not answer', async () => {
    const log = logger();
    const runner = distribution((args, options) => {
      if (args[0] === '--terminate') return failed('There is no distribution with the supplied name.');
      if (isScript(args) && options?.input === DOCKER_WAIT_SCRIPT) return failed('systemd does not run in the distribution.');
      return undefined;
    });
    await expect(setup({ runner, log }).setUp(undefined, () => undefined)).rejects.toMatchObject({
      problem: 'dockerNotRunning',
      message: expect.stringContaining('after its restart (exit code 1): systemd does not run in the distribution.'),
    });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('wsl.exe --terminate devspaces failed (exit code 1)'));
  });
});

describe('WslSetup.remove', () => {
  it('unregisters the distribution and removes the folder of Devspaces', async () => {
    fs.mkdirSync(path.join(folder, 'disk'));
    const runner = wslRunner((args) => (args.join(' ') === WSL_UNREGISTER_ARGS.join(' ') ? ok() : undefined), { Ubuntu: 'C:\\WSL\\Ubuntu' });
    await setup({ runner }).remove();
    expect(runner.calls.map((call) => call.args[0])).toEqual([WSL_UNREGISTER_ARGS[0], 'export']);
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('keeps the folder of Devspaces when another distribution has its virtual disk there', async () => {
    fs.mkdirSync(path.join(folder, 'disk'));
    fs.writeFileSync(path.join(folder, 'disk', 'ext4.vhdx'), 'other');
    const runner = wslRunner((args) => (args.join(' ') === WSL_UNREGISTER_ARGS.join(' ') ? ok() : undefined), { other: path.join(folder, 'disk') });
    await setup({ runner }).remove();
    expect(fs.readdirSync(path.join(folder, 'disk'))).toEqual(['ext4.vhdx']);
  });

  it('keeps the folder when WSL refuses', async () => {
    const runner = wslRunner(() => failed('Access is denied.'));
    await expect(setup({ runner }).remove()).rejects.toEqual(new WslSetupError('removeFailed', 'wsl.exe --unregister devspaces failed (exit code 1): Access is denied.'));
    expect(fs.existsSync(folder)).toBe(true);
  });
});

describe('WslSetup.locked', () => {
  it('runs one setup or removal at a time for all windows', async () => {
    let release: () => void = () => {};
    const first = setup({ runner: wslRunner(() => undefined) }).locked(() => new Promise<string>((resolve) => (release = () => resolve('first'))));
    // Until the first task holds the lock.
    await vi.waitFor(() => expect(fs.existsSync(`${folder}.lock`)).toBe(true));
    const task = vi.fn(async () => 'second');
    await expect(setup({ runner: wslRunner(() => undefined) }).locked(task)).resolves.toBeUndefined();
    expect(task).not.toHaveBeenCalled();
    release();
    await expect(first).resolves.toEqual({ value: 'first' });
    expect(fs.existsSync(`${folder}.lock`)).toBe(false);
    await expect(setup({ runner: wslRunner(() => undefined) }).locked(task)).resolves.toEqual({ value: 'second' });
  });

  it('gives the failure of its task, also a lock time-out of the task itself', async () => {
    await expect(setup({ runner: wslRunner(() => undefined) }).locked(async () => Promise.reject(new LockTimeoutError('other.lock')))).rejects.toBeInstanceOf(LockTimeoutError);
    await expect(setup({ runner: wslRunner(() => undefined) }).locked(async () => Promise.reject(new Error('EACCES')))).rejects.toThrow('EACCES');
  });
});

describe('WslSetup.removeLeftovers', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(folder, 'disk'));
    fs.writeFileSync(path.join(folder, 'disk', 'ext4.vhdx'), 'old');
  });

  it('removes the folder of Devspaces when no WSL distribution has its virtual disk there', async () => {
    const runner = wslRunner(() => undefined, { Ubuntu: 'C:\\WSL\\Ubuntu' });
    await setup({ runner }).removeLeftovers();
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('removes it without the registry when WSL lists no distribution devspaces', async () => {
    const runner = wslRunner(() => ok('Ubuntu\r\n'), failed('Access is denied.'));
    await setup({ runner }).removeLeftovers();
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('keeps it when the registry does not tell the folder of a distribution and WSL lists devspaces', async () => {
    const runner = withRawRegistry(wslRunner(() => ok('devspaces\r\n')), ['[HKEY_CURRENT_USER\\Lxss\\{1}]', '"DistributionName"="devspaces"', '"BasePath"=hex(2):43,00']);
    await setup({ runner }).removeLeftovers();
    expect(fs.readdirSync(path.join(folder, 'disk'))).toEqual(['ext4.vhdx']);
  });

  it('removes it without a key in the registry when WSL has no distribution', async () => {
    const noDistribution = failed('Windows Subsystem for Linux has no installed distributions.\r\nError code: Wsl/WSL_E_DEFAULT_DISTRO_NOT_FOUND', 4294967295);
    const runner = wslRunner(() => noDistribution, failed('ERROR: The system was unable to find the specified registry key or value.'));
    await setup({ runner }).removeLeftovers();
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('keeps it when a distribution has its disk there, when the registry does not tell, and does nothing without it', async () => {
    await setup({ runner: wslRunner(() => undefined, { other: path.join(folder, 'disk', 'other') }) }).removeLeftovers();
    await setup({ runner: wslRunner(() => undefined, failed('Access is denied.')) }).removeLeftovers();
    expect(fs.readdirSync(path.join(folder, 'disk'))).toEqual(['ext4.vhdx']);
    fs.rmSync(folder, { recursive: true });
    const runner = wslRunner(() => undefined);
    await setup({ runner }).removeLeftovers();
    expect(runner.calls).toEqual([]);
  });
});

describe('the scripts in the distribution', () => {
  it('are valid for sh', () => {
    for (const script of [PROVISION_SCRIPT, DOCKER_WAIT_SCRIPT]) {
      const result = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    }
  });

  it('write the settings of WSL and install the packages of Docker from its repository, in the order of the steps', () => {
    expect(PROVISION_SCRIPT).toContain(`cat > /etc/wsl.conf <<'WSLCONF'\n${WSL_CONF}\nWSLCONF\n`);
    expect(WSL_CONF).toContain('[boot]\nsystemd=true');
    expect(PROVISION_SCRIPT).toContain('apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin');
    expect(PROVISION_SCRIPT).toContain('URIs: https://download.docker.com/linux/debian');
    const steps = [...PROVISION_SCRIPT.matchAll(/^step (\w+)$/gm)].map((match) => match[1]);
    expect(steps).toEqual(['packages', 'repository', 'docker']);
    // No command reads the rest of the script from standard input.
    expect(PROVISION_SCRIPT.trimEnd().endsWith('main < /dev/null')).toBe(true);
  });

  it('run one at a time, end an interrupted installation first, and know their own policy-rc.d', () => {
    expect(PROVISION_SCRIPT).toContain('exec 9> /run/devspaces-setup.lock\nif ! flock -n 9; then');
    expect(PROVISION_SCRIPT.indexOf('run dpkg --configure -a')).toBeLessThan(PROVISION_SCRIPT.indexOf('run apt-get update'));
    // systemd is on only after its installation.
    expect(PROVISION_SCRIPT.indexOf('systemd systemd-sysv')).toBeLessThan(PROVISION_SCRIPT.indexOf('cat > /etc/wsl.conf'));
    expect(PROVISION_SCRIPT).toContain(`grep -qxF '${WSL_POLICY_MARK}' /usr/sbin/policy-rc.d`);
    expect(PROVISION_SCRIPT).toContain(`cat > /usr/sbin/policy-rc.d <<'POLICY'\n${WSL_POLICY}\nPOLICY\n`);
    // It keeps services from starting only while a run holds the lock.
    expect(WSL_POLICY).toBe(`#!/bin/sh\n${WSL_POLICY_MARK}\nflock -n /run/devspaces-setup.lock true || exit 101`);
  });
});
