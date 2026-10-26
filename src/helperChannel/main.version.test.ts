// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The worker takes the version of Devspaces of its environment (DEVSPACES_VERSION, which the extension and the Monitor
// set) at its start (startChannel), for the header User-Agent of its HTTPS requests and for the Monitor that it
// creates. The channel server, the standard streams and the signals of this process are replaced: the test checks only
// the start.
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The options of each channel server that the start made. */
const servers = vi.hoisted(() => [] as unknown[]);
vi.mock('./server', async (original) => {
  const actual = await original<typeof import('./server')>();
  class QuietServer {
    constructor(options: unknown) {
      servers.push(options);
    }
    start(): void {}
    input(): void {}
    inputEnded(): void {}
    shutdown(): void {}
  }
  return { ...actual, ChannelServer: QuietServer };
});

import { setUserAgentVersion, userAgent } from '../core/http';
import { startChannel } from './main';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  servers.length = 0;
  setUserAgentVersion(undefined);
});

/** startChannel with DEVSPACES_VERSION set to `version` (missing for undefined). */
function start(version: string | undefined): void {
  vi.spyOn(process, 'on').mockImplementation((() => process) as never);
  vi.spyOn(process.stdout, 'on').mockImplementation((() => process.stdout) as never);
  vi.spyOn(process.stdin, 'on').mockImplementation((() => process.stdin) as never);
  vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
  vi.stubEnv('DEVSPACES_VERSION', version);
  startChannel('');
  expect(servers).toHaveLength(1);
  servers.length = 0;
}

describe('the start of the worker', () => {
  it('names the version of DEVSPACES_VERSION in the header User-Agent', () => {
    start('1.20.3');
    expect(userAgent()).toBe('nimblescape-devspaces/1.20.3');
  });

  it('without a version x.y.z, the header has no version', () => {
    for (const version of [undefined, '1.20', '1.20.3\r\nX-Other: 1']) {
      setUserAgentVersion('9.9.9');
      start(version);
      expect(userAgent(), String(version)).toBe('nimblescape-devspaces');
    }
  });
});
