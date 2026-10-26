// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { PIPE_LOADER, encodeBundle } from '../loader/pipeLoader';
import type { StateDevspace } from '../pipeline/refreshStates';
import { ENV_API, ENV_WEB, EXPECTED_STATES, REFRESH_DEVSPACES } from '../pipeline/refreshStates.testkit';
import { LABEL_CHANNEL_STEP, LABEL_HELPER_CHANNEL, LABEL_HELPER_RUN } from '../names';
import { LABEL_MONITOR } from '../remoteMonitor/protocol';
import { batchRunSpec } from './batch';
import { channelRunArgs } from './helperChannels';
import {
  MIN_SECRET_LENGTH,
  CHANNEL_ENTRY,
  CHANNEL_SCRIPT_PATH,
  CHANNEL_SILENCE_EXIT_MS,
  CHANNEL_PING_INTERVAL_MS,
  CHANNEL_PONG_TIMEOUT_MS,
  CHANNEL_IDLE_CLOSE_MS,
  CHANNEL_SERVER_IDLE_EXIT_MS,
  LineSplitter,
  MAX_CLIENT_LINE,
  MAX_SECRET_LENGTH,
  MAX_REFRESH_BRANCH_LENGTH,
  MAX_REFRESH_DEVSPACES,
  parseRefreshParams,
  parseRefreshValue,
  refreshValue,
  channelLabelValue,
  channelStepLabel,
  isCleanupLabel,
  newCleanupLabel,
  encodeMessage,
  parseClientMessage,
  engineIdentity,
  parseEngineIdentity,
  parseProbeParams,
  parseProbeValue,
  MAX_PROBE_DETAIL_LENGTH,
  parseSweepParams,
  parseSweepValue,
  sameEngine,
  SWEEP_FILTERS,
  parseServerMessage,
  refusedOperationId,
  StreamRedactor,
  MAX_CONFIGURATION_PATH_LENGTH,
  MAX_LISTED_CONFIGURATIONS,
  parseListConfigurationsParams,
  parseListConfigurationsValue,
  MAX_DELETE_VOLUMES,
  parseDeleteParams,
  parseDeleteValue,
  parseDeleteCheckParams,
  parseDeleteCheckValue,
} from './protocol';

describe('the protocol of the helper channel', () => {
  it('keeps the times in the order that makes the script end by itself and the extension notice a loss first', () => {
    // Several pings fit into the silence, so a lost ping or two does not end a working channel.
    expect(CHANNEL_SILENCE_EXIT_MS).toBeGreaterThanOrEqual(3 * CHANNEL_PING_INTERVAL_MS);
    // The extension gives up on the script before the script gives up on the extension. The loss is checked at each
    // ping, so it is noticed at most one interval after the pong timeout.
    expect(CHANNEL_PONG_TIMEOUT_MS + CHANNEL_PING_INTERVAL_MS).toBeLessThan(CHANNEL_SILENCE_EXIT_MS);
    expect(CHANNEL_PONG_TIMEOUT_MS).toBeGreaterThan(CHANNEL_PING_INTERVAL_MS);
    // The script's own idle limit is a backstop behind the extension's.
    expect(CHANNEL_SERVER_IDLE_EXIT_MS).toBeGreaterThan(CHANNEL_IDLE_CLOSE_MS);
  });

  it('parses the messages of the extension strictly', () => {
    expect(parseClientMessage('{"t":"hello","protocol":1}')).toEqual({ t: 'hello', protocol: 1 });
    expect(parseClientMessage('{"t":"ping","n":3}')).toEqual({ t: 'ping', n: 3 });
    expect(parseClientMessage('{"t":"cancel","id":2}')).toEqual({ t: 'cancel', id: 2 });
    // Named secrets.
    expect(parseClientMessage('{"t":"op","id":1,"op":"docker","params":{"args":["ps"]},"secrets":{"token":"s3cr"},"timeoutMs":5}')).toEqual({
      t: 'op',
      id: 1,
      op: 'docker',
      params: { args: ['ps'] },
      secrets: { token: 's3cr' },
      timeoutMs: 5,
    });
    for (const line of [
      'not json',
      '[]',
      '{"t":"hello","protocol":-1}',
      '{"t":"hello","protocol":1,"x":1}',
      '{"t":"op","id":1,"op":"Bad-Name","params":null}',
      '{"t":"op","id":1.5,"op":"docker","params":null}',
      '{"t":"op","id":1,"op":"docker"}',
      '{"t":"op","id":1,"op":"docker","params":null,"timeoutMs":0}',
      `{"t":"op","id":1,"op":"docker","params":null,"secret":"${'x'.repeat(MAX_SECRET_LENGTH + 1)}"}`,
      // A secret too short to be masked.
      '{"t":"op","id":1,"op":"docker","params":null,"secret":"abc"}',
      '{"t":"op","id":1,"op":"docker","params":null,"secret":""}',
      '{"t":"quit"}',
    ]) {
      expect(parseClientMessage(line), line.slice(0, 60)).toBeUndefined();
    }
    expect(parseClientMessage(`{"t":"ping","n":1,"pad":"${'x'.repeat(MAX_CLIENT_LINE)}"}`)).toBeUndefined();
    expect(refusedOperationId('{"t":"op","id":7,"op":"Bad"}')).toBe(7);
    expect(refusedOperationId('{"t":"ping","id":7}')).toBeUndefined();
  });

  it('parses the messages of the script strictly', () => {
    expect(parseServerMessage('{"t":"hello","protocol":1,"node":"v24","ops":["docker"]}')).toEqual({ t: 'hello', protocol: 1, node: 'v24', ops: ['docker'] });
    expect(parseServerMessage('{"t":"progress","id":1,"step":"Cloning"}')).toEqual({ t: 'progress', id: 1, step: 'Cloning' });
    // The confirmation of a cancel.
    expect(parseServerMessage('{"t":"cancelled","id":4}')).toEqual({ t: 'cancelled', id: 4 });
    expect(parseServerMessage('{"t":"cancelled","id":4,"x":1}')).toBeUndefined();
    expect(parseServerMessage('{"t":"log","id":1,"level":"warn","text":"x"}')).toEqual({ t: 'log', id: 1, level: 'warn', text: 'x' });
    expect(parseServerMessage('{"t":"out","id":1,"stream":"stderr","data":"x"}')).toEqual({ t: 'out', id: 1, stream: 'stderr', data: 'x' });
    expect(parseServerMessage('{"t":"result","id":1,"ok":true,"value":{"a":1}}')).toEqual({ t: 'result', id: 1, ok: true, value: { a: 1 } });
    expect(parseServerMessage('{"t":"result","id":1,"ok":false,"error":{"code":"c","message":"m"},"cancelled":true,"timedOut":false}')).toEqual({
      t: 'result',
      id: 1,
      ok: false,
      error: { code: 'c', message: 'm' },
      cancelled: true,
      timedOut: false,
    });
    for (const line of [
      '{"t":"hello","protocol":1,"node":"v24","ops":["Bad Op"]}',
      '{"t":"log","id":1,"level":"error","text":"x"}',
      '{"t":"out","id":1,"stream":"stdin","data":"x"}',
      '{"t":"result","id":1,"ok":false,"error":{"code":"c"},"cancelled":true,"timedOut":false}',
      '{"t":"result","id":1,"ok":"yes"}',
      '{"t":"pong"}',
    ]) {
      expect(parseServerMessage(line), line).toBeUndefined();
    }
  });

  it('encodes a message and the script as one line each', () => {
    expect(encodeMessage({ t: 'log', id: 1, level: 'info', text: 'a\nb' })).toBe('{"t":"log","id":1,"level":"info","text":"a\\nb"}\n');
    // The script as the line of the pipe loader (encodeBundle).
    expect(encodeBundle('line 1\nline 2')).toBe('"line 1\\nline 2"\n');
  });

  it('LineSplitter passes whole lines on and fails once on a line that is too long', () => {
    const lines: string[] = [];
    let tooLong = 0;
    const splitter = new LineSplitter(5, (line) => lines.push(line), () => tooLong++);
    splitter.push('ab');
    splitter.push('c\n\nde\nf');
    expect(lines).toEqual(['abc', 'de']);
    splitter.push('123456');
    expect(tooLong).toBe(1);
    splitter.push('\nok\n');
    expect(lines).toEqual(['abc', 'de']);
  });

  // The shared pipe loader gets the path and `startChannel` as arguments (channelRunArgs, see pipeLoader.test.ts).
  it('the loader stores the script at CHANNEL_SCRIPT_PATH and starts CHANNEL_ENTRY', () => {
    expect(CHANNEL_SCRIPT_PATH).toBe('/opt/devspace/channel.js');
    expect(CHANNEL_ENTRY).toBe('startChannel');
    expect(PIPE_LOADER).not.toContain(CHANNEL_SCRIPT_PATH);
    // It is one argument of `docker run`: one line.
    expect(PIPE_LOADER).not.toContain('\n');
  });

  it('the cleanup label: its values, and the label of a step container', () => {
    expect(isCleanupLabel('0a1b2c3d4e5f60718293a4b5')).toBe(true);
    expect(isCleanupLabel('abc123')).toBe(false);
    // Only values of newCleanupLabel (24 hex digits), each new.
    expect(isCleanupLabel('cancel-0a1b2c3d')).toBe(false);
    expect(isCleanupLabel(newCleanupLabel())).toBe(true);
    expect(newCleanupLabel()).not.toBe(newCleanupLabel());
    expect(isCleanupLabel('a'.repeat(65))).toBe(false);
    expect(channelStepLabel('0a1b2c3d')).toBe('nimblescape.devspaces.channel-step=0a1b2c3d');
  });

  it('channelLabelValue names the protocol, the script and the loader', () => {
    // The protocol is version 3.
    expect(channelLabelValue('a')).toMatch(/^3-[0-9a-f]{12}$/);
    expect(channelLabelValue('a')).not.toBe(channelLabelValue('b'));
    // The pipe loader is part of the label (a new loader, a new version).
    const hash = createHash('sha256').update('a', 'utf8').update('\n', 'utf8').update(PIPE_LOADER, 'utf8').digest('hex');
    expect(channelLabelValue('a')).toBe(`3-${hash.slice(0, 12)}`);
    expect(channelLabelValue('a')).not.toBe(`3-${createHash('sha256').update('a').digest('hex').slice(0, 12)}`);
  });

  it('checks the value of probe', () => {
    expect(parseProbeValue({ serverVersion: '27', detail: 'd' })).toEqual({ serverVersion: '27', detail: 'd' });
    expect(parseProbeValue({ detail: 3 })).toBeUndefined();
    // A detail longer than the worker sends is refused.
    expect(parseProbeValue({ detail: 'x'.repeat(MAX_PROBE_DETAIL_LENGTH) })).toEqual({ detail: 'x'.repeat(MAX_PROBE_DETAIL_LENGTH) });
    expect(parseProbeValue({ detail: 'x'.repeat(MAX_PROBE_DETAIL_LENGTH + 1) })).toBeUndefined();
  });

  // The engine identity of the probe is checked strictly: engineIdentity answers the values of the output of the Docker
  // CLI, and the engine of ProbeValue is those values, checked by parseEngineIdentity.
  it('engineIdentity and the engine of ProbeValue', () => {
    const engine = { id: '7b1c:ABCD', rootDir: '/var/lib/docker' };
    expect(engineIdentity('"7b1c:ABCD" "/var/lib/docker"\n')).toEqual(engine);
    expect(engineIdentity('"" "/var/lib/docker"')).toBeUndefined();
    expect(engineIdentity('"id"')).toBeUndefined();
    expect(engineIdentity('WARNING: x\n"id" "/r"')).toBeUndefined();
    expect(engineIdentity(`"${'a'.repeat(2_000)}" "/r"`)).toBeUndefined();
    expect(engineIdentity('"id" ""')).toEqual({ id: 'id', rootDir: '' });
    expect(parseProbeValue({ serverVersion: '27', detail: 'd', engine })).toEqual({ serverVersion: '27', detail: 'd', engine });
    expect(parseProbeValue({ serverVersion: '27', detail: 'd', engine: 3 })).toBeUndefined();
    // The text of the Docker CLI is no engine; nor is an identity with another key or without a value.
    expect(parseProbeValue({ serverVersion: '27', detail: 'd', engine: '"7b1c:ABCD" "/var/lib/docker"' })).toBeUndefined();
    expect(parseProbeValue({ serverVersion: '27', detail: 'd', engine: { ...engine, other: 1 } })).toBeUndefined();
    expect(parseProbeValue({ serverVersion: '27', detail: 'd', engine: { id: '7b1c:ABCD' } })).toBeUndefined();
    expect(parseProbeValue({ serverVersion: '27', detail: 'd', engine, other: 1 })).toBeUndefined();
  });

  // The identity is compared as its values, so the escapes of Go's `{{json}}` (`<`, `>` and `&` as \u003c, \u003e and
  // \u0026, which JSON.stringify leaves as they are) never make the same engine another one.
  it('compares the identity of the Docker CLI and of the Engine API as values', () => {
    const cli = engineIdentity('"id-1" "/srv/docker\\u0026\\u003cdata\\u003e"');
    expect(cli).toEqual({ id: 'id-1', rootDir: '/srv/docker&<data>' });
    const api = parseEngineIdentity({ id: 'id-1', rootDir: '/srv/docker&<data>' });
    expect(sameEngine(cli!, api!)).toBe(true);
    expect(sameEngine(cli!, { id: 'id-2', rootDir: '/srv/docker&<data>' })).toBe(false);
    expect(sameEngine(cli!, { id: 'id-1', rootDir: '/var/lib/docker' })).toBe(false);
  });

  it('parseEngineIdentity takes an ID of 1 to 1024 characters and a root folder of at most 1024, nothing else', () => {
    expect(parseEngineIdentity({ id: 'a'.repeat(1_024), rootDir: 'r'.repeat(1_024) })).toEqual({ id: 'a'.repeat(1_024), rootDir: 'r'.repeat(1_024) });
    for (const value of [
      { id: '', rootDir: '/r' },
      { id: 'a'.repeat(1_025), rootDir: '/r' },
      { id: 'a', rootDir: 'r'.repeat(1_025) },
      { id: 1, rootDir: '/r' },
      { id: 'a', rootDir: null },
      { id: 'a' },
      { id: 'a', rootDir: '/r', extra: true },
      ['a', '/r'],
      null,
      '"a" "/r"',
    ]) {
      expect(parseEngineIdentity(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  // The probe and the sweep take no parameters, by one schema on both sides.
  it('parseProbeParams and parseSweepParams take no parameters', () => {
    for (const parse of [parseProbeParams, parseSweepParams]) {
      for (const value of [{}, null, undefined]) expect(parse(value)).toEqual({});
      for (const value of [{ x: 1 }, [], 'x', 0, false, { undefined: undefined }]) expect(parse(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  // The sweep has the label and age filters of `docker container prune -f`, and no other.
  it('the sweep prunes by the label of the helper containers (any value), never the Monitor, and an age of 10 minutes, and answers how many it removed', () => {
    // The label of every helper container, never one with the label of the Monitor.
    expect(SWEEP_FILTERS).toEqual({ label: [LABEL_HELPER_RUN], 'label!': [LABEL_MONITOR], until: ['10m'] });
    expect(parseSweepValue({ removed: 0 })).toEqual({ removed: 0 });
    expect(parseSweepValue({ removed: 3 })).toEqual({ removed: 3 });
    for (const value of [{ removed: -1 }, { removed: 1.5 }, { removed: '1' }, { removed: Number.MAX_SAFE_INTEGER + 1 }, { removed: 1, output: 'x' }, { output: 'Deleted Containers:' }, null, [], 2]) {
      expect(parseSweepValue(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});

describe('the helper containers that the sweep removes when they are stopped', () => {
  it('the channels and the batch helpers carry the label of the sweep (any value); the batch helpers also their session label', () => {
    // The volume of the shared VS Code server store is required.
    const run = channelRunArgs({ tag: 't', socketPath: '/var/run/docker.sock', stateVolume: 'devspaces-monitor', vscodeVolume: 'devspaces-vscode', containerName: 'devspaces-api-worker1', label: 'l', scriptHash: 'h' });
    const labels = run.flatMap((arg, index) => (run[index - 1] === '--label' ? [arg] : []));
    expect(labels).toContain(`${LABEL_HELPER_RUN}=true`);
    expect(labels).toContain(`${LABEL_HELPER_CHANNEL}=l`);
    const batch = batchRunSpec({ session: 's', volume: 'v', image: `sha256:${'a'.repeat(64)}`, socket: '/var/run/docker.sock', scriptHash: 'h' });
    expect(batch.labels).toEqual({ [LABEL_HELPER_RUN]: 'true', [LABEL_CHANNEL_STEP]: 's' });
    // Never the label that guards the Monitor.
    expect(labels.some((label) => label.startsWith(LABEL_MONITOR))).toBe(false);
    expect(Object.keys(batch.labels)).not.toContain(LABEL_MONITOR);
  });
});

describe('the refresh operation', () => {
  const env: StateDevspace = { id: ENV_API, containerName: 'devspaces-api', volumeName: 'devspaces-api-vol', folder: '/workspaces/api', branch: true };

  it('accepts at most MAX_REFRESH_DEVSPACES devspaces of the strict shape', () => {
    expect(parseRefreshParams({ devspaces: REFRESH_DEVSPACES })).toEqual({ devspaces: REFRESH_DEVSPACES });
    expect(parseRefreshParams({ devspaces: [] })).toEqual({ devspaces: [] });
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ ...env, id: `env-${index}` }));
    expect(parseRefreshParams({ devspaces: many(MAX_REFRESH_DEVSPACES) })?.devspaces).toHaveLength(MAX_REFRESH_DEVSPACES);
    expect(parseRefreshParams({ devspaces: many(MAX_REFRESH_DEVSPACES + 1) })).toBeUndefined();
    expect(parseRefreshParams({ devspaces: [{ ...env, user: 'node' }] })?.devspaces[0].user).toBe('node');
    expect(parseRefreshParams({ devspaces: [{ ...env, user: '1000:1000' }] })).toBeDefined();
  });

  it('refuses anything else', () => {
    for (const value of [
      undefined,
      null,
      [],
      {},
      { devspaces: {} },
      { devspaces: [env], other: 1 },
      { devspaces: [env, env] },
      { devspaces: [{ ...env, extra: true }] },
      { devspaces: [{ ...env, id: '../x' }] },
      { devspaces: [{ ...env, id: '' }] },
      { devspaces: [{ ...env, containerName: '-e' }] },
      { devspaces: [{ ...env, containerName: 'a b' }] },
      { devspaces: [{ ...env, volumeName: '--mount' }] },
      { devspaces: [{ ...env, volumeName: 3 }] },
      { devspaces: [{ ...env, user: '' }] },
      { devspaces: [{ ...env, user: '-u' }] },
      { devspaces: [{ ...env, user: 'a b' }] },
      { devspaces: [{ ...env, folder: '/etc' }] },
      { devspaces: [{ ...env, folder: '/workspaces/..' }] },
      { devspaces: [{ ...env, folder: '/workspaces/a/b' }] },
      { devspaces: [{ ...env, folder: 'workspaces/api' }] },
      { devspaces: [{ ...env, branch: 'yes' }] },
      { devspaces: [{ id: env.id, containerName: env.containerName, volumeName: env.volumeName, folder: env.folder }] },
    ]) {
      expect(parseRefreshParams(value)).toBeUndefined();
    }
  });

  it('checks the value against its parameters', () => {
    const params = parseRefreshParams({ devspaces: REFRESH_DEVSPACES })!;
    const value = refreshValue(EXPECTED_STATES);
    expect(parseRefreshValue(JSON.parse(JSON.stringify(value)), params)).toEqual(EXPECTED_STATES);
    const running = { id: ENV_API, container: 'running', volume: true };
    const one = parseRefreshParams({ devspaces: [env] })!;
    expect(parseRefreshValue({ runtime: [running], branches: [{ id: ENV_API, branch: 'main' }] }, one)).toEqual({
      runtime: new Map([[ENV_API, { container: 'running', volume: true }]]),
      branches: new Map([[ENV_API, 'main']]),
    });
    for (const bad of [
      undefined,
      { runtime: [running] },
      { runtime: [running], branches: [], other: 1 },
      // Missing, duplicate, or unknown devspaces.
      { runtime: [], branches: [] },
      { runtime: [running, running], branches: [] },
      { runtime: [{ ...running, id: ENV_WEB }], branches: [] },
      // Invalid states.
      { runtime: [{ ...running, container: 'paused' }], branches: [] },
      { runtime: [{ ...running, volume: 'yes' }], branches: [] },
      { runtime: [{ ...running, servicesRunning: false }], branches: [] },
      { runtime: [{ ...running, extra: 1 }], branches: [] },
      // Branches of another devspace, of a container that does not run, or invalid names.
      { runtime: [running], branches: [{ id: ENV_WEB, branch: 'main' }] },
      { runtime: [{ ...running, container: 'stopped' }], branches: [{ id: ENV_API, branch: 'main' }] },
      { runtime: [running], branches: [{ id: ENV_API, branch: 'main' }, { id: ENV_API, branch: 'main' }] },
      { runtime: [running], branches: [{ id: ENV_API, branch: '' }] },
      { runtime: [running], branches: [{ id: ENV_API, branch: ' main' }] },
      { runtime: [running], branches: [{ id: ENV_API, branch: 'a\nb' }] },
      { runtime: [running], branches: [{ id: ENV_API, branch: 'b'.repeat(MAX_REFRESH_BRANCH_LENGTH + 1) }] },
    ]) {
      expect(parseRefreshValue(bad, one)).toBeUndefined();
    }
    // No branch of a devspace whose branch was not asked for.
    const notAsked = parseRefreshParams({ devspaces: [{ ...env, branch: false }] })!;
    expect(parseRefreshValue({ runtime: [running], branches: [{ id: ENV_API, branch: 'main' }] }, notAsked)).toBeUndefined();
  });
});

describe('StreamRedactor', () => {
  it('flush forwards the held-back tail that could have been the start of the secret', () => {
    const forwarded: string[] = [];
    const redactor = new StreamRedactor('ghp_abcd', (text) => forwarded.push(text));
    redactor.push('building');
    // The `g` may start the secret, so it waits for the next piece.
    expect(forwarded.join('')).toBe('buildin');
    redactor.flush();
    expect(forwarded.join('')).toBe('building');
  });
});

describe('StreamRedactor at the end of a cut stream', () => {
  it('flush masks a held-back start of a secret of MIN_SECRET_LENGTH characters or more; a shorter one passes', () => {
    const secret = 'SUPERSECRETVALUE';
    for (let held = 1; held < secret.length; held++) {
      const forwarded: string[] = [];
      const redactor = new StreamRedactor(secret, (text) => forwarded.push(text));
      redactor.push(`abc ${secret.slice(0, held)}`);
      redactor.flush();
      expect(forwarded.join('')).toBe(held >= MIN_SECRET_LENGTH ? 'abc ***' : `abc ${secret.slice(0, held)}`);
    }
  });
});

describe('StreamRedactor at every split', () => {
  /** Pushes the pieces and returns what was forwarded, joined, after flush. */
  function stream(secret: string, pieces: string[]): string {
    const forwarded: string[] = [];
    const redactor = new StreamRedactor(secret, (text) => forwarded.push(text));
    for (const piece of pieces) redactor.push(piece);
    redactor.flush();
    return forwarded.join('');
  }

  const cases: Array<{ secret: string; text: string; expected: string }> = [
    { secret: 'ghp_abcd', text: 'x ghp_abcd y', expected: 'x *** y' },
    // Self-overlapping: the secret is 'ab' four times; the text holds it once, plus a longer run and a partial one.
    { secret: 'abababab', text: 'z abababab q ababababab ababab z', expected: 'z *** q ***ab ababab z' },
    { secret: 'aabcd', text: 'xaabcd aaabcd', expected: 'x*** a***' },
  ];

  it('never forwards the secret when the text is split at any position, and keeps the rest of the text', () => {
    for (const { secret, text, expected } of cases) {
      expect(stream(secret, [text]), secret).toBe(expected);
      for (let k = 0; k <= text.length; k++) {
        const joined = stream(secret, [text.slice(0, k), text.slice(k)]);
        expect(joined, `${secret} split at ${k}`).not.toContain(secret);
        expect(joined, `${secret} split at ${k}`).toBe(expected);
        for (let m = k; m <= text.length; m++) {
          expect(stream(secret, [text.slice(0, k), text.slice(k, m), text.slice(m)]), `${secret} split at ${k} and ${m}`).toBe(expected);
        }
      }
    }
  });

  it('never forwards the secret when the text comes one character per push', () => {
    for (const { secret, text, expected } of cases) {
      const joined = stream(secret, [...text]);
      expect(joined, secret).not.toContain(secret);
      expect(joined, secret).toBe(expected);
    }
  });

  it('holds back the longest tail that starts the secret, not the shortest', () => {
    const forwarded: string[] = [];
    const redactor = new StreamRedactor('abababab', (text) => forwarded.push(text));
    redactor.push('x ababab');
    // All of 'ababab' could start the secret, so only 'x ' is forwarded.
    expect(forwarded.join('')).toBe('x ');
    redactor.push('ab y');
    redactor.flush();
    expect(forwarded.join('')).toBe('x *** y');
  });
});

// The checks of the listing's parameters and answer.
describe('listConfigurations: its parameters and its answer', () => {
  const PARAMS = { devspaceId: '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d', dockerHost: 'build-box', owner: { windowId: 'window-1', pid: 42 } };
  it('takes its parameters only within their limits', () => {
    expect(parseListConfigurationsParams(PARAMS)).toEqual(PARAMS);
    expect(parseListConfigurationsParams({ ...PARAMS, dockerHost: 'h'.repeat(1024) })).toBeDefined();
    for (const odd of [
      { ...PARAMS, dockerHost: 'h'.repeat(1025) },
      { ...PARAMS, dockerHost: 'a\nb' },
      { ...PARAMS, owner: { ...PARAMS.owner, extra: 1 } },
      { ...PARAMS, owner: { windowId: 'w/x', pid: 42 } },
      { ...PARAMS, owner: { windowId: 'w', pid: 0 } },
      { ...PARAMS, owner: { windowId: 'w', pid: 1.5 } },
      { ...PARAMS, devspaceId: '../x' },
      { ...PARAMS, extra: true },
    ]) {
      expect(parseListConfigurationsParams(odd), JSON.stringify(odd).slice(0, 80)).toBeUndefined();
    }
  });

  it('takes an answer of paths only within their limits, and never paths and a refusal together', () => {
    const many = Array.from({ length: MAX_LISTED_CONFIGURATIONS }, (_, index) => `c${index}/devcontainer.json`);
    expect(parseListConfigurationsValue({ configPaths: many })).toEqual({ configPaths: many });
    expect(parseListConfigurationsValue({ configPaths: ['p'.repeat(MAX_CONFIGURATION_PATH_LENGTH)] })).toBeDefined();
    for (const odd of [
      { configPaths: ['a\nb'] },
      { configPaths: ['a\u001bb'] },
      { configPaths: [''] },
      { configPaths: ['p'.repeat(MAX_CONFIGURATION_PATH_LENGTH + 1)] },
      { configPaths: [...many, 'one/more.json'] },
      { configPaths: [42] },
      { configPaths: [], refused: { code: 'startFailed', message: 'm' } },
      { refused: { code: 'unknown', message: 'm' } },
      {},
    ]) {
      expect(parseListConfigurationsValue(odd), JSON.stringify(odd).slice(0, 80)).toBeUndefined();
    }
    expect(parseListConfigurationsValue({ refused: { code: 'startFailed', message: 'm' } })).toEqual({ refused: { code: 'startFailed', message: 'm' } });
  });
});

describe('delete: its parameters and its answer', () => {
  const PARAMS = {
    devspaceId: '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d',
    dockerHost: 'build-box',
    owner: { windowId: 'window-1', pid: 42 },
    additionalVolumesToRemove: ['api-db', 'devspaces-acme-api_data'],
    monitorSource: '0123456789abcdef0123456789abcdef',
  };
  it('takes its parameters only within their limits', () => {
    expect(parseDeleteParams(PARAMS)).toEqual(PARAMS);
    expect(parseDeleteParams({ ...PARAMS, additionalVolumesToRemove: Array.from({ length: MAX_DELETE_VOLUMES }, (_, i) => `v${i}`) })).toBeDefined();
    for (const odd of [
      { ...PARAMS, additionalVolumesToRemove: Array.from({ length: MAX_DELETE_VOLUMES + 1 }, (_, i) => `v${i}`) },
      { ...PARAMS, additionalVolumesToRemove: ['../etc'] },
      { ...PARAMS, additionalVolumesToRemove: ['-v'] },
      { ...PARAMS, additionalVolumesToRemove: [1] },
      { ...PARAMS, additionalVolumesToRemove: 'api-db' },
      { ...PARAMS, monitorSource: 'ABCDEF0123456789abcdef0123456789' },
      { ...PARAMS, monitorSource: undefined },
      { ...PARAMS, owner: { windowId: 'w', pid: 0 } },
      { ...PARAMS, devspaceId: '../x' },
      { ...PARAMS, dockerHost: 'a\nb' },
      { ...PARAMS, extra: true },
    ]) {
      expect(parseDeleteParams(odd), JSON.stringify(odd).slice(0, 80)).toBeUndefined();
    }
  });

  it('answers deleted, or a refusal of the pipeline', () => {
    expect(parseDeleteValue({ deleted: true })).toEqual({ deleted: true });
    expect(parseDeleteValue({ refused: { code: 'startFailed', message: 'm' } })).toEqual({ refused: { code: 'startFailed', message: 'm' } });
    for (const odd of [{}, { deleted: false }, { deleted: true, extra: 1 }, { refused: { code: 'cancelled', message: 'm' } }, { refused: { code: 'nope', message: 'm' } }, null, 'deleted']) {
      expect(parseDeleteValue(odd), JSON.stringify(odd)).toBeUndefined();
    }
  });
});

describe('deleteCheck: its parameters and its answer', () => {
  const PARAMS = { devspaceId: '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d', dockerHost: '', owner: { windowId: 'window-1', pid: 42 }, repository: 'Acme/API', otherWindow: false };
  it('takes its parameters only within their limits', () => {
    expect(parseDeleteCheckParams(PARAMS)).toEqual(PARAMS);
    expect(parseDeleteCheckParams({ ...PARAMS, repository: 'r'.repeat(256) })).toBeDefined();
    for (const odd of [
      { ...PARAMS, repository: '' },
      { ...PARAMS, repository: 'r'.repeat(257) },
      { ...PARAMS, repository: 'a\u007fb' },
      { ...PARAMS, otherWindow: 'false' },
      { ...PARAMS, owner: { windowId: 'w', pid: 0 } },
      { ...PARAMS, extra: 1 },
    ]) {
      expect(parseDeleteCheckParams(odd), JSON.stringify(odd).slice(0, 80)).toBeUndefined();
    }
  });

  it('answers the decision of the user, or a refusal of the pipeline', () => {
    expect(parseDeleteCheckValue({ decision: 'delete', additionalVolumesToRemove: ['api-db'] })).toEqual({ decision: 'delete', additionalVolumesToRemove: ['api-db'] });
    expect(parseDeleteCheckValue({ decision: 'open' })).toEqual({ decision: 'open' });
    expect(parseDeleteCheckValue({ decision: 'cancel' })).toEqual({ decision: 'cancel' });
    expect(parseDeleteCheckValue({ refused: { code: 'otherAccount', message: 'm' } })).toEqual({ refused: { code: 'otherAccount', message: 'm' } });
    for (const odd of [
      { decision: 'delete' },
      { decision: 'delete', additionalVolumesToRemove: ['../x'] },
      { decision: 'delete', additionalVolumesToRemove: Array.from({ length: MAX_DELETE_VOLUMES + 1 }, (_, i) => `v${i}`) },
      { decision: 'open', additionalVolumesToRemove: [] },
      { decision: 'maybe' },
      { refused: { code: 'cancelled', message: 'm' } },
      null,
    ]) {
      expect(parseDeleteCheckValue(odd), JSON.stringify(odd)?.slice(0, 80)).toBeUndefined();
    }
  });
});
