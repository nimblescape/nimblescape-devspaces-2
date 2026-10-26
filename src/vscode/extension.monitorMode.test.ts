// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// extension.ts gives the Monitor of an engine the schedule of its background run (cacheUpdateSchedule), its mode
// (permanent on every engine, local or remote, once the user answered the question about the Monitor of that engine,
// unless stopMonitorWhenIdle is on) and the ID of this computer. The settings come from monitorSettings.ts and are
// tested by their result; only that extension.ts calls them with the Docker host of the open and the target of the
// repair is read from its source (extension.ts cannot be loaded without VS Code).
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { monitorSettingsOf, type MonitorSettingsDeps } from './monitorSettings';

const COMPUTER = 'c'.repeat(32);

/** The settings, and the engines (by their host) whose Monitor question was answered. */
const deps = (settings: ReturnType<MonitorSettingsDeps['settings']>, answered: readonly string[] = ['', 'user@host']): MonitorSettingsDeps & { asked: string[] } => {
  const asked: string[] = [];
  return {
    settings: () => settings,
    answered: async (host) => {
      asked.push(host);
      return answered.includes(host);
    },
    timeZone: () => 'Europe/Vienna',
    computerId: () => COMPUTER,
    asked,
  };
};

describe('the monitor settings of extension.ts', () => {
  // The default is daily at 06:07; the settings carry no prefixes.
  it('the schedule of cacheUpdateSchedule (default daily at 06:07) and the time zone', async () => {
    const settings = monitorSettingsOf(deps({ cacheUpdateSchedule: '60' }));
    expect(await settings.forOpen('')).toEqual({ schedule: '60', timeZone: 'Europe/Vienna', permanent: true, computer: COMPUTER });
    expect((await monitorSettingsOf(deps({})).forOpen('')).schedule).toBe('7 6 * * *');
  });

  it('the mode: the same rule on every engine, permanent after the answer there unless stopMonitorWhenIdle is on', async () => {
    for (const stop of [true, false, undefined]) {
      const given = deps(stop === undefined ? {} : { stopMonitorWhenIdle: stop });
      const settings = monitorSettingsOf(given);
      for (const each of [await settings.forOpen('user@host'), await settings.forTarget({ kind: 'remote', host: 'user@host' }), await settings.forOpen(''), await settings.forTarget({ kind: 'local', host: '' })]) {
        expect(each, String(stop)).toEqual({ schedule: '7 6 * * *', timeZone: 'Europe/Vienna', permanent: stop !== true, computer: COMPUTER });
      }
      // The answer of the engine of the open, and of the target.
      expect(given.asked).toEqual(['user@host', 'user@host', '', '']);
    }
  });

  it('without an answer for the engine, its monitor ends when idle, whatever the setting says', async () => {
    for (const stop of [true, false, undefined]) {
      const settings = monitorSettingsOf(deps(stop === undefined ? {} : { stopMonitorWhenIdle: stop }, ['']));
      expect((await settings.forOpen('build-box')).permanent, String(stop)).toBe(false);
      expect((await settings.forTarget({ kind: 'remote', host: 'build-box' })).permanent, String(stop)).toBe(false);
      expect((await settings.forTarget({ kind: 'unsupported', host: 'tcp://10.0.0.5:2375' })).permanent, String(stop)).toBe(false);
      // The local Docker has its answer.
      expect((await settings.forOpen('')).permanent, String(stop)).toBe(stop !== true);
    }
  });

  // The ensure then replaces a permanent Monitor of this computer with one that stops when idle; the log says why.
  it('an answer that cannot be read counts as none, with a warning, and the open goes on', async () => {
    for (const [answered, cause] of [
      [async () => Promise.reject(new Error('EACCES: permission denied')), 'EACCES: permission denied'],
      [() => { throw new Error('EIO'); }, 'EIO'],
    ] as const) {
      const warnings: string[] = [];
      const settings = monitorSettingsOf({ ...deps({}), answered: answered as MonitorSettingsDeps['answered'], logger: { warn: (message) => warnings.push(message) } });
      expect(await settings.forOpen('')).toEqual({ schedule: '7 6 * * *', timeZone: 'Europe/Vienna', permanent: false, computer: COMPUTER });
      expect(await settings.forTarget({ kind: 'remote', host: 'build-box' })).toMatchObject({ permanent: false });
      expect(warnings).toEqual([
        `The answer about the Monitor on the local Docker could not be read, so the Monitor there stops when no devspace runs: ${cause}`,
        `The answer about the Monitor on build-box could not be read, so the Monitor there stops when no devspace runs: ${cause}`,
      ]);
    }
    // Without a logger nothing is logged, and nothing fails.
    const quiet = monitorSettingsOf({ ...deps({}), answered: async () => Promise.reject(new Error('EIO')) });
    expect((await quiet.forOpen('')).permanent).toBe(false);
  });

  it('a computer ID that cannot be read is left out, and the open goes on', async () => {
    const settings = monitorSettingsOf({
      ...deps({}),
      computerId: () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(await settings.forOpen('')).toEqual({ schedule: '7 6 * * *', timeZone: 'Europe/Vienna', permanent: true });
  });

  it('extension.ts gives an open the settings of its Docker host, and a repair and "Update All Images Now" those of their target', () => {
    const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
    // No image list of imageLists.
    expect(source).toContain('openMonitor: async (dockerHost) => ({ images: await monitorSettings.forOpen(dockerHost) }),');
    expect(source).not.toContain('imageLists');
    expect(source).not.toContain('read:packages');
    expect(source).toContain('monitorCalls.monitorEnsure(target, await monitorSettings.forTarget(target), signal)');
    expect(source).toContain('monitorCalls.monitorRunNow(target, await monitorSettings.forTarget(target), signal)');
    // The answers of the engines come from their records; one that cannot be read is logged.
    expect(source).toContain('answered: (host) => engineRecords.monitorAnswered(host),');
    expect(source).toMatch(/const monitorSettings = monitorSettingsOf\(\{[^}]*\n\s*logger,\n\s*\}\);/);
    expect(source).not.toContain('imageUpdateSchedule ??');
  });
});
