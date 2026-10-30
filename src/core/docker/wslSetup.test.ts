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
import { WSL_LIST_ARGS } from './dockerHost';
import {
  DOCKER_WAIT_SCRIPT,
  PROVISION_SCRIPT,
  WSL_CONF,
  WSL_DISTRIBUTION_LIST_URL,
  WSL_TERMINATE_ARGS,
  WSL_UNREGISTER_ARGS,
  WslSetup,
  WslSetupError,
  debianImageOf,
  parseWslVersion,
  supportsFromFile,
  wslInstallArgs,
  wslSetupFolder,
  type WslSetupStep,
} from './wslSetup';

const WSL = 'C:\\Windows\\System32\\wsl.exe';
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

/** A runner of `wsl.exe` that answers each call with `answer`; a call that `answer` does not know fails the test. */
function wslRunner(answer: (args: readonly string[], options?: RunOptions) => RunResult | Error | undefined) {
  const calls: Call[] = [];
  return {
    calls,
    run: vi.fn(async (file: string, args: readonly string[], options?: RunOptions) => {
      calls.push({ file, args, options });
      const result = answer(args, options);
      if (result instanceof Error) throw result;
      if (result === undefined) throw new Error(`unexpected wsl.exe ${args.join(' ')}`);
      return result;
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
  it('registers the file under the name devspaces in the folder, without a start', () => {
    expect(wslInstallArgs('C:\\x\\debian.wsl', 'C:\\x\\disk')).toEqual([
      '--install',
      '--from-file',
      'C:\\x\\debian.wsl',
      '--name',
      'devspaces',
      '--location',
      'C:\\x\\disk',
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

describe('WslSetup.registration', () => {
  it('is none without a distribution of that name, also when WSL lists none with an exit code', async () => {
    const empty = wslRunner(() => failed('Windows Subsystem for Linux has no installed distributions.', 4294967295));
    await expect(setup({ runner: empty }).registration()).resolves.toBe('none');
    expect(empty.calls[0].args).toEqual(WSL_LIST_ARGS);
    const others = wslRunner(() => ok('Ubuntu\r\ndocker-desktop\r\n'));
    await expect(setup({ runner: others }).registration()).resolves.toBe('none');
  });

  it('is own when the virtual disk is in the folder of Devspaces, else foreign (names without case)', async () => {
    const runner = wslRunner(() => ok('Ubuntu\r\nDevspaces\r\n'));
    await expect(setup({ runner }).registration()).resolves.toBe('foreign');
    fs.mkdirSync(path.join(folder, 'disk'));
    await expect(setup({ runner }).registration()).resolves.toBe('foreign');
    fs.writeFileSync(path.join(folder, 'disk', 'ext4.vhdx'), '');
    await expect(setup({ runner }).registration()).resolves.toBe('own');
  });

  it('says that WSL does not answer instead of none when the list ends by its time limit', async () => {
    const runner = wslRunner(() => timedOut);
    await expect(setup({ runner }).registration()).rejects.toMatchObject({ problem: 'wslNotAnswering' });
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

  /** A distribution that answers each step; `override` changes the answer of one. */
  function distribution(override: (args: readonly string[], options?: RunOptions) => RunResult | Error | undefined = () => undefined) {
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
    });
  }

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
    expect(runner.calls.map((call) => call.args)).toEqual([
      wslInstallArgs(file, path.join(folder, 'disk')),
      ['-d', 'devspaces', '-u', 'root', '--cd', '/', '--exec', 'sh', '-s'],
      WSL_TERMINATE_ARGS,
      ['-d', 'devspaces', '-u', 'root', '--cd', '/', '--exec', 'sh', '-s'],
    ]);
    expect(runner.calls.every((call) => call.options?.env?.WSL_UTF8 === '1')).toBe(true);
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
    expect(runner.calls.map((call) => call.args[0])).toEqual(['-d', '--terminate', '-d']);
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
    expect(runner.calls).toHaveLength(1);
  });

  it('names the time limit of a script that does not end', async () => {
    const runner = distribution((args, options) => (isScript(args) && options?.input === PROVISION_SCRIPT ? timedOut : undefined));
    await expect(setup({ runner }).setUp(undefined, () => undefined)).rejects.toMatchObject({
      problem: 'dockerFailed',
      message: expect.stringContaining('(no end within 30 minutes): (no output)'),
    });
    expect(runner.calls[0].options?.timeoutMs).toBe(30 * 60_000);
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
    const runner = wslRunner((args) => (args.join(' ') === WSL_UNREGISTER_ARGS.join(' ') ? ok() : undefined));
    await setup({ runner }).remove();
    expect(runner.calls.map((call) => call.args)).toEqual([WSL_UNREGISTER_ARGS]);
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('keeps the folder when WSL refuses', async () => {
    const runner = wslRunner(() => failed('Access is denied.'));
    await expect(setup({ runner }).remove()).rejects.toEqual(new WslSetupError('removeFailed', 'wsl.exe --unregister devspaces failed (exit code 1): Access is denied.'));
    expect(fs.existsSync(folder)).toBe(true);
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
});
