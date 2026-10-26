// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The background build of a helper image that the refresh found
// missing: one build at a time per window and engine, a wait after a failed one, none on an engine that does not answer,
// and the refresh after a build. With the real HelperChannels: the refresh that finds no helper image asks for it, and
// the refresh after the build reads the states.
import { describe, expect, it, vi } from 'vitest';
import { LOCAL_DOCKER_TARGET, dockerTargetOf, remoteContextNames, type DockerTarget } from '../docker/dockerHost';
import type { HelperChannel } from '../helperChannel/helperChannel';
import { HelperChannels } from '../helperChannel/helperChannels';
import { refreshValue } from '../helperChannel/protocol';
import { EXPECTED_STATES, REFRESH_DEVSPACES } from '../pipeline/refreshStates.testkit';
import { silentLogger } from '../ports';
import { MISSING_HELPER_RETRY_MS, MissingHelperBuild, type MissingHelperBuildDeps } from './missingHelperBuild';

const REMOTE: DockerTarget = dockerTargetOf('ssh://devspace', remoteContextNames('devspace')[0]);
const OTHER: DockerTarget = dockerTargetOf('ssh://build-box', remoteContextNames('build-box')[0]);

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(overrides: Partial<MissingHelperBuildDeps> = {}) {
  const clock = { value: 1_000_000, now: () => clock.value };
  const builds: Array<{ target: DockerTarget; done: ReturnType<typeof deferred<void>> }> = [];
  const defaults = {
    engineAnswers: vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => true),
    build: vi.fn((target: DockerTarget, _signal: AbortSignal) => {
      const done = deferred<void>();
      builds.push({ target, done });
      return done.promise;
    }),
    progress: vi.fn(<T>(_target: DockerTarget, work: () => Promise<T>) => work()),
    onBuilt: vi.fn((_target: DockerTarget) => {}),
    onChange: vi.fn(() => {}),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() },
    clock,
  };
  const deps = { ...defaults, ...overrides } as typeof defaults & Partial<MissingHelperBuildDeps>;
  return { deps, clock, builds, helper: new MissingHelperBuild(deps) };
}

/** The signal of the first build. */
function buildSignal(h: ReturnType<typeof harness>): AbortSignal {
  return h.deps.build.mock.calls[0][1];
}

describe('MissingHelperBuild', () => {
  // "Remove Devspaces from This Docker Engine…" stops the build on its engine before it removes the helper images.
  // Mutation: a stop that does not cancel the build waits for it to end (the test times out).
  it('stop cancels the build on that host and waits for its end; no wait starts, and the build on another host goes on', async () => {
    const h = harness({
      build: vi.fn(
        (_target: DockerTarget, signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
      ),
    });
    const remote = h.helper.request(REMOTE);
    const other = h.helper.request(OTHER);
    await vi.waitFor(() => expect(h.deps.build).toHaveBeenCalledTimes(2));
    const changes = h.deps.onChange.mock.calls.length;
    await h.helper.stop({ host: 'devspace' });
    expect(await remote).toBe('cancelled');
    expect(h.helper.status('devspace')).toBeUndefined();
    // The sidebar shows the engine without the build.
    expect(h.deps.onChange.mock.calls.length).toBe(changes + 1);
    expect(h.deps.logger.info).toHaveBeenCalledWith('The background build of the workspace helper image on devspace was stopped: Devspaces is being removed from there.');
    expect(h.deps.logger.warn).not.toHaveBeenCalled();
    expect(h.deps.onBuilt).not.toHaveBeenCalled();
    expect(h.helper.status('build-box')).toBe('building');
    // No wait starts there (the removal mark keeps the refresh from asking again).
    expect(h.helper.request(REMOTE)).toBeDefined();
    // Nothing runs on that host: the stop ends at once.
    await h.helper.stop({ host: 'nowhere' });
    h.helper.dispose();
    expect(await other).toBe('cancelled');
  });

  // The removal must not remove the helper image while the build still runs. Mutation: a stop that does not wait for
  // the end of the build returns while the build still runs.
  it('stop waits for a build that ends a moment after its cancel', async () => {
    const ended = deferred<void>();
    const h = harness({
      build: vi.fn(
        (_target: DockerTarget, signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => void ended.promise.then(() => reject(signal.reason)), { once: true })),
      ),
    });
    const job = h.helper.request(REMOTE);
    await vi.waitFor(() => expect(h.deps.build).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stop = h.helper.stop({ host: 'devspace' }).then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(buildSignal(h).aborted).toBe(true);
    expect(stopped).toBe(false);
    expect(h.helper.status('devspace')).toBe('building');
    ended.resolve(undefined);
    await stop;
    expect(h.helper.status('devspace')).toBeUndefined();
    expect(await job).toBe('cancelled');
  });

  it('builds a missing helper image once, shows it in the status bar, then refreshes', async () => {
    const h = harness();
    const job = h.helper.request(REMOTE);
    expect(job).toBeDefined();
    expect(h.helper.status('devspace')).toBe('building');
    expect(h.deps.onChange).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.builds).toHaveLength(1));
    // Every later refresh while it runs asks again: no second build.
    for (let i = 0; i < 5; i++) expect(h.helper.request(REMOTE)).toBeUndefined();
    expect(h.deps.engineAnswers).toHaveBeenCalledTimes(1);
    expect(h.deps.progress).toHaveBeenCalledTimes(1);
    expect(h.deps.progress.mock.calls[0][0]).toBe(REMOTE);
    expect(h.deps.onBuilt).not.toHaveBeenCalled();
    h.builds[0].done.resolve(undefined);
    expect(await job).toBe('built');
    expect(h.deps.build).toHaveBeenCalledTimes(1);
    expect(h.deps.build.mock.calls[0][0]).toBe(REMOTE);
    expect(h.deps.onBuilt).toHaveBeenCalledTimes(1);
    expect(h.deps.onBuilt).toHaveBeenCalledWith(REMOTE);
    expect(h.helper.status('devspace')).toBeUndefined();
    // A refresh that still finds no image right after (for example the image cannot be checked while the window's build
    // of it is cached) starts no loop of builds and refreshes: the wait applies after a build too.
    expect(h.helper.request(REMOTE)).toBeUndefined();
    h.clock.value += MISSING_HELPER_RETRY_MS;
    expect(h.helper.request(REMOTE)).toBeDefined();
  });

  it('runs one build per engine: another engine gets its own; the status is per Docker host', async () => {
    const h = harness();
    expect(h.helper.request(REMOTE)).toBeDefined();
    expect(h.helper.request(OTHER)).toBeDefined();
    expect(h.helper.request(LOCAL_DOCKER_TARGET)).toBeDefined();
    await vi.waitFor(() => expect(h.builds).toHaveLength(3));
    expect(h.builds.map((build) => build.target)).toEqual([REMOTE, OTHER, LOCAL_DOCKER_TARGET]);
    h.builds[1].done.resolve(undefined);
    await vi.waitFor(() => expect(h.helper.status('build-box')).toBeUndefined());
    expect(h.helper.status('devspace')).toBe('building');
    expect(h.helper.status('')).toBe('building');
    expect(h.helper.status('elsewhere')).toBeUndefined();
  });

  it('after a failed build, waits MISSING_HELPER_RETRY_MS before it builds there again; a build elsewhere ends the wait', async () => {
    const h = harness();
    const first = h.helper.request(REMOTE);
    await vi.waitFor(() => expect(h.builds).toHaveLength(1));
    h.builds[0].done.reject(new Error('no network'));
    expect(await first).toBe('failed');
    expect(h.deps.onBuilt).not.toHaveBeenCalled();
    expect(h.helper.status('devspace')).toBe('failed');
    expect(h.deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not be built in the background on devspace: no network'));
    // Within the wait: every refresh is refused at once, no build and no check of the engine.
    h.clock.value += MISSING_HELPER_RETRY_MS - 1;
    expect(h.helper.request(REMOTE)).toBeUndefined();
    expect(h.deps.engineAnswers).toHaveBeenCalledTimes(1);
    // Other engines are not held back.
    expect(h.helper.request(OTHER)).toBeDefined();
    // After the wait: once more.
    h.clock.value += 1;
    expect(h.helper.status('devspace')).toBeUndefined();
    const again = h.helper.request(REMOTE);
    expect(again).toBeDefined();
    await vi.waitFor(() => expect(h.builds).toHaveLength(3));
    h.builds[2].done.reject(new Error('still no network'));
    expect(await again).toBe('failed');
    expect(h.helper.request(REMOTE)).toBeUndefined();
    // A Start that built the image (HelperImagesDeps.onImageBuilt) ends the wait.
    h.helper.clearFailures();
    expect(h.helper.status('devspace')).toBeUndefined();
    expect(h.helper.request(REMOTE)).toBeDefined();
  });

  it('never builds on an engine that does not answer, and starts no wait there', async () => {
    const h = harness({ engineAnswers: vi.fn(async () => false) });
    const job = h.helper.request(REMOTE);
    expect(await job).toBe('unreachable');
    expect(h.deps.build).not.toHaveBeenCalled();
    expect(h.deps.progress).not.toHaveBeenCalled();
    expect(h.deps.onBuilt).not.toHaveBeenCalled();
    expect(h.helper.status('devspace')).toBeUndefined();
    // The status changed back (the sidebar renders it again).
    expect(h.deps.onChange).toHaveBeenCalledTimes(2);
    // No wait: the next refresh that finds no helper image checks the engine again.
    expect(await h.helper.request(REMOTE)).toBe('unreachable');
    expect(h.deps.engineAnswers).toHaveBeenCalledTimes(2);
  });

  it('nothing for an endpoint that is neither local nor SSH, nor after dispose; dispose cancels a build', async () => {
    const h = harness();
    expect(h.helper.request(dockerTargetOf('tcp://10.0.0.1:2375', 'tcp-context'))).toBeUndefined();
    const job = h.helper.request(REMOTE);
    await vi.waitFor(() => expect(h.builds).toHaveLength(1));
    const signal = buildSignal(h);
    expect(signal.aborted).toBe(false);
    h.helper.dispose();
    expect(signal.aborted).toBe(true);
    h.builds[0].done.reject(signal.reason);
    expect(await job).toBe('cancelled');
    expect(h.deps.onBuilt).not.toHaveBeenCalled();
    expect(h.helper.request(REMOTE)).toBeUndefined();
    expect(h.helper.status('devspace')).toBeUndefined();
  });

  it('ends a build at its time limit; that counts as a failed build', async () => {
    const h = harness({ timeoutMs: 20 });
    const job = h.helper.request(REMOTE);
    await vi.waitFor(() => expect(h.builds).toHaveLength(1));
    const signal = buildSignal(h);
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    h.builds[0].done.reject(signal.reason);
    expect(await job).toBe('failed');
    expect(h.deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('its time limit ended'));
    expect(h.helper.status('devspace')).toBe('failed');
  });
});

describe('HelperChannels with MissingHelperBuild', () => {
  /** A worker that answers the refresh with EXPECTED_STATES. */
  function worker() {
    return {
      isOpen: true,
      busy: 0,
      lastUsed: Date.now(),
      onClose: () => () => {},
      close: () => {},
      closeNow: () => {},
      operation: vi.fn(async () => refreshValue(EXPECTED_STATES)),
      flow: vi.fn(async () => ({ ok: true })),
    };
  }

  it('the refresh that finds no helper image asks for one background build, and the refresh after it reads the states', async () => {
    let present = false;
    const checkPresent = vi.fn(async () => {
      if (!present) throw new Error('The workspace helper image is not on this Docker engine.');
    });
    const open = vi.fn(async () => worker() as unknown as HelperChannel);
    const prepare = vi.fn(async (_target: DockerTarget, _signal: AbortSignal | undefined) => {});
    const refreshes: Array<Promise<unknown>> = [];
    let channels: HelperChannels | undefined;
    const done = deferred<void>();
    const builds = new MissingHelperBuild({
      engineAnswers: async () => true,
      // The build of Start, Stop and Delete: the `prepare` of the worker (here: the image appears when it is released).
      build: async (target, signal) => {
        await done.promise;
        await prepare(target, signal);
        present = true;
      },
      onBuilt: (target) => {
        refreshes.push(channels!.refresh(target, REFRESH_DEVSPACES));
      },
      logger: silentLogger,
    });
    const request = vi.spyOn(builds, 'request');
    channels = new HelperChannels({ open, prepare, checkPresent, onRefreshWithoutHelper: (target) => void builds.request(target), logger: silentLogger });
    // Every refresh is refused at once (never a build, never a wait), and asks; one build runs.
    for (let i = 0; i < 3; i++) {
      await expect(channels.refresh(REMOTE, REFRESH_DEVSPACES)).rejects.toMatchObject({ code: 'unavailable' });
    }
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.results.filter((result) => result.value !== undefined)).toHaveLength(1);
    expect(builds.status('devspace')).toBe('building');
    expect(open).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    // A flow (a Start) or another passive read never asks for it.
    await channels.flow(REMOTE, 'windowState', {}, { passive: true }).catch(() => undefined);
    expect(request).toHaveBeenCalledTimes(3);
    done.resolve();
    await vi.waitFor(() => expect(refreshes).toHaveLength(1));
    expect(await refreshes[0]).toEqual(EXPECTED_STATES);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(builds.status('devspace')).toBeUndefined();
    channels.dispose();
  });
});
