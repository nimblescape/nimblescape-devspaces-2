// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  addDockerFolderToPath,
  dockerProcessEnv,
  envValue,
  extraSearchFolders,
  findDockerCli,
  findExecutable,
  isExecutableFile,
  windowsDockerDesktopFolders,
} from './dockerCli';

function existing(...files: string[]): { exists: (file: string) => boolean; probed: string[] } {
  const probed: string[] = [];
  const set = new Set(files);
  return {
    probed,
    exists: (file: string) => {
      probed.push(file);
      return set.has(file);
    },
  };
}

describe('extraSearchFolders', () => {
  it('lists the Homebrew and Docker Desktop folders on macOS', () => {
    expect(extraSearchFolders('darwin')).toEqual([
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/Applications/Docker.app/Contents/Resources/bin',
    ]);
  });

  it('adds the per-user folders of Docker Desktop on macOS when HOME is known', () => {
    expect(extraSearchFolders('darwin', { HOME: '/Users/me' })).toEqual([
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/Applications/Docker.app/Contents/Resources/bin',
      '/Users/me/.docker/bin',
      '/Users/me/Applications/Docker.app/Contents/Resources/bin',
    ]);
    // A relative HOME is ignored (it would name a folder of the opened workspace).
    expect(extraSearchFolders('darwin', { HOME: 'me' })).toHaveLength(3);
  });

  it('finds the Docker CLI of a per-user Docker Desktop installation on macOS', () => {
    const fake = existing('/Users/me/.docker/bin/docker');
    expect(findDockerCli({ PATH: '/usr/bin:/bin', HOME: '/Users/me' }, 'darwin', fake.exists)).toBe('/Users/me/.docker/bin/docker');
  });

  it('lists the Docker Desktop folder on Windows', () => {
    expect(extraSearchFolders('win32')).toEqual(['C:\\Program Files\\Docker\\Docker\\resources\\bin']);
  });

  it('uses ProgramFiles on Windows when Program Files is not on drive C', () => {
    expect(extraSearchFolders('win32', { ProgramFiles: 'D:\\Programs' })).toEqual([
      'D:\\Programs\\Docker\\Docker\\resources\\bin',
      'C:\\Program Files\\Docker\\Docker\\resources\\bin',
    ]);
  });

  it('adds the folder of a per-user Docker Desktop installation on Windows when LOCALAPPDATA is known', () => {
    expect(extraSearchFolders('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })).toEqual([
      'C:\\Program Files\\Docker\\Docker\\resources\\bin',
      'C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin',
    ]);
  });

  it('finds the Docker CLI of a per-user Docker Desktop installation on Windows with a PATH from before the installation', () => {
    const cli = 'C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin\\docker.exe';
    const fake = existing(cli);
    expect(findDockerCli({ Path: 'C:\\Windows\\System32', LocalAppData: 'C:\\Users\\me\\AppData\\Local' }, 'win32', fake.exists)).toBe(cli);
    expect(fake.probed).toEqual([
      'C:\\Windows\\System32\\docker.exe',
      'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
      cli,
    ]);
  });

  it('lists the usual folders on Linux', () => {
    expect(extraSearchFolders('linux')).toEqual(['/usr/local/bin', '/usr/bin']);
  });
});

describe('windowsDockerDesktopFolders', () => {
  it('deduplicates case-insensitively and ignores relative values', () => {
    expect(
      windowsDockerDesktopFolders({ ProgramW6432: 'c:\\program files', PROGRAMFILES: 'relative', LOCALAPPDATA: 'AppData\\Local' }),
    ).toEqual(['c:\\program files\\Docker\\Docker']);
  });

  it('lists the folder of an installation for all users first, then the per-user folder in LOCALAPPDATA', () => {
    expect(windowsDockerDesktopFolders({ LocalAppData: 'C:\\Users\\me\\AppData\\Local', ProgramFiles: 'D:\\Programs' })).toEqual([
      'D:\\Programs\\Docker\\Docker',
      'C:\\Program Files\\Docker\\Docker',
      'C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop',
    ]);
  });
});

describe('envValue', () => {
  it('is case-insensitive on Windows only', () => {
    expect(envValue({ Path: 'x' }, 'PATH', 'win32')).toBe('x');
    expect(envValue({ Path: 'x' }, 'PATH', 'linux')).toBeUndefined();
  });
});

describe('findExecutable', () => {
  it('searches PATH in order and skips relative entries', () => {
    const fake = existing('/b/docker', '/c/docker');
    expect(findExecutable('docker', { PATH: '/a:relative::/b:/c' }, 'linux', fake.exists)).toBe('/b/docker');
    expect(fake.probed).toEqual(['/a/docker', '/b/docker']);
  });

  it('finds the Docker Desktop CLI on macOS with a short PATH', () => {
    const fake = existing('/Applications/Docker.app/Contents/Resources/bin/docker');
    expect(findDockerCli({ PATH: '/usr/bin:/bin' }, 'darwin', fake.exists)).toBe(
      '/Applications/Docker.app/Contents/Resources/bin/docker',
    );
    expect(fake.probed).toEqual([
      '/usr/bin/docker',
      '/bin/docker',
      '/usr/local/bin/docker',
      '/opt/homebrew/bin/docker',
      '/Applications/Docker.app/Contents/Resources/bin/docker',
    ]);
  });

  it('prefers Homebrew over the app bundle on macOS', () => {
    const fake = existing('/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker');
    expect(findDockerCli({}, 'darwin', fake.exists)).toBe('/opt/homebrew/bin/docker');
  });

  it('adds .exe on Windows, reads Path case-insensitively, and removes quotes', () => {
    const fake = existing('C:\\Tools\\docker.exe');
    expect(findDockerCli({ Path: 'C:\\Windows;"C:\\Tools"' }, 'win32', fake.exists)).toBe('C:\\Tools\\docker.exe');
    expect(fake.probed[0]).toBe('C:\\Windows\\docker.exe');
  });

  it('does not add a second .exe', () => {
    const fake = existing('C:\\Tools\\docker-credential-desktop.exe');
    expect(findExecutable('docker-credential-desktop.exe', { PATH: 'C:\\Tools' }, 'win32', fake.exists)).toBe(
      'C:\\Tools\\docker-credential-desktop.exe',
    );
  });

  it('falls back to the Docker Desktop folder on Windows', () => {
    const fake = existing('C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe');
    expect(findDockerCli({ Path: 'C:\\Windows' }, 'win32', fake.exists)).toBe(
      'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
    );
  });

  it('checks each folder once', () => {
    const fake = existing();
    findExecutable('docker', { PATH: '/usr/local/bin:/usr/local/bin/:/usr/bin' }, 'linux', fake.exists);
    expect(fake.probed).toEqual(['/usr/local/bin/docker', '/usr/bin/docker']);
  });

  it('returns undefined when the program does not exist', () => {
    expect(findDockerCli({ PATH: '/x' }, 'linux', () => false)).toBeUndefined();
  });

  it('only checks an absolute name', () => {
    const fake = existing('/opt/docker');
    expect(findExecutable('/opt/docker', { PATH: '/usr/bin' }, 'linux', fake.exists)).toBe('/opt/docker');
    expect(fake.probed).toEqual(['/opt/docker']);
  });
});

describe('dockerProcessEnv', () => {
  it('appends the CLI folder and the extra folders to PATH', () => {
    const env = { PATH: '/usr/bin:/bin', HOME: '/Users/me' };
    const result = dockerProcessEnv(env, 'darwin', '/Applications/Docker.app/Contents/Resources/bin/docker');
    expect(result.PATH).toBe(
      '/usr/bin:/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/local/bin:/opt/homebrew/bin' +
        ':/Users/me/.docker/bin:/Users/me/Applications/Docker.app/Contents/Resources/bin',
    );
    expect(result.HOME).toBe('/Users/me');
    expect(env.PATH).toBe('/usr/bin:/bin');
  });

  it('is idempotent', () => {
    const once = dockerProcessEnv({ PATH: '/usr/bin' }, 'linux', '/opt/docker/bin/docker');
    const twice = dockerProcessEnv(once, 'linux', '/opt/docker/bin/docker');
    expect(twice).toEqual(once);
    expect(once.PATH).toBe('/usr/bin:/opt/docker/bin:/usr/local/bin');
  });

  it('works without PATH', () => {
    expect(dockerProcessEnv({}, 'linux').PATH).toBe('/usr/local/bin:/usr/bin');
  });

  it('keeps the spelling Path on Windows and removes other spellings', () => {
    const result = dockerProcessEnv(
      { Path: 'C:\\Windows', PATH: 'C:\\Other' },
      'win32',
      'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
    );
    expect(Object.keys(result).filter((key) => key.toLowerCase() === 'path')).toEqual(['Path']);
    expect(result.Path).toBe('C:\\Windows;C:\\Program Files\\Docker\\Docker\\resources\\bin');
  });

  it('compares folders case-insensitively on Windows', () => {
    const value = 'C:\\Windows;c:\\program files\\docker\\docker\\resources\\bin\\';
    expect(dockerProcessEnv({ Path: value }, 'win32').Path).toBe(value);
  });
});

describe('addDockerFolderToPath', () => {
  const cli = 'C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin\\docker.exe';

  it('puts the folder of the CLI at the end of PATH on Windows, under the spelling of the key', () => {
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows;C:\\Tools;' };
    expect(addDockerFolderToPath(env, 'win32', cli)).toBe(true);
    expect(env).toEqual({ Path: 'C:\\Windows;C:\\Tools;C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin' });
  });

  it('changes nothing when PATH contains the folder (case-insensitively, also with a trailing backslash)', () => {
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows;c:\\users\\me\\appdata\\local\\programs\\dockerdesktop\\resources\\bin\\' };
    expect(addDockerFolderToPath(env, 'win32', cli)).toBe(false);
    expect(env.PATH).toBe('C:\\Windows;c:\\users\\me\\appdata\\local\\programs\\dockerdesktop\\resources\\bin\\');
  });

  it('sets PATH when there is none on Windows', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(addDockerFolderToPath(env, 'win32', cli)).toBe(true);
    expect(env).toEqual({ Path: 'C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin' });
  });

  it('changes nothing on macOS and Linux', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    expect(addDockerFolderToPath(env, 'darwin', '/Applications/Docker.app/Contents/Resources/bin/docker')).toBe(false);
    expect(addDockerFolderToPath(env, 'linux', '/opt/docker/bin/docker')).toBe(false);
    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});

describe('isExecutableFile', () => {
  it.skipIf(process.platform === 'win32')('requires a regular, executable file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-test-'));
    try {
      const executable = path.join(dir, 'docker');
      const plain = path.join(dir, 'plain');
      fs.writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 });
      fs.writeFileSync(plain, 'text', { mode: 0o644 });
      fs.symlinkSync(executable, path.join(dir, 'link'));
      fs.symlinkSync(path.join(dir, 'missing'), path.join(dir, 'dangling'));
      expect(isExecutableFile(executable)).toBe(true);
      expect(isExecutableFile(path.join(dir, 'link'))).toBe(true);
      expect(isExecutableFile(plain)).toBe(false);
      expect(isExecutableFile(dir)).toBe(false);
      expect(isExecutableFile(path.join(dir, 'dangling'))).toBe(false);
      expect(isExecutableFile(path.join(dir, 'missing'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
