// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The image calls of WorkspaceHelper (mutation testing). WorkspaceHelper wraps no HelperImages and has no Docker port:
// its image call (that of the pipeline) gives the own image of HelperDeps and touches no Docker image (the worker has
// no Dockerfile and builds nothing), and a step of the batch helper runs on that image with the socket of HelperDeps
// (the worker's own); the socket of the endpoint of a Docker context is HelperImages' (helperImages.rules.test.ts).
import { describe, expect, it } from 'vitest';
import type { HeldDevspaceLock } from '../docker/devspaceLock';
import type { HelperBatchSession } from '../helperChannel/helperChannel';
import { silentLogger } from '../ports';
import { runWithBatchScope } from './batchScope';
import { WorkspaceHelper } from './workspaceHelper';

const OWN = { tag: 'devspaces-worker:own', id: `sha256:${'b'.repeat(64)}` };

class SocketLock implements HeldDevspaceLock {
  readonly devspaceId = 'e';
  readonly lost = new Promise<string>(() => {});
  readonly opens: { image: string; socket: string }[] = [];
  async release(): Promise<void> {}
  async batch(p: { volume: string; image: string; socket: string }): Promise<HelperBatchSession> {
    this.opens.push({ image: p.image, socket: p.socket });
    return {
      session: 's',
      lost: new Promise<string>(() => {}),
      step: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      close: async () => {},
    };
  }
}

// The own image, the socket and containerRuns.
function helper(socket: string): WorkspaceHelper {
  return new WorkspaceHelper({
    logger: silentLogger,
    ownImage: OWN,
    socket,
    containerRuns: async () => {
      throw new Error('no container query');
    },
  });
}

async function ownershipFix(h: WorkspaceHelper): Promise<{ image: string; socket: string }[]> {
  const lock = new SocketLock();
  await runWithBatchScope(lock, 'vol', silentLogger, () => h.fixConfigOwnership({ volumeName: 'vol', folder: '/workspaces/.devspace+', uid: '1000', gid: '1000' }));
  return lock.opens;
}

describe('WorkspaceHelper with its own image', () => {
  it('passes an abort through on each image call', async () => {
    const h = helper('/s.sock');
    const controller = new AbortController();
    controller.abort();
    const signal = controller.signal;
    await expect(h.ownImageUse(signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await h.ownImageUse()).toEqual(OWN);
  });

  // The socket is the one of HelperDeps (the worker's own socket).
  it('runs a step of the batch helper on its own image with the recorded socket of the engine', async () => {
    const opens = await ownershipFix(helper('/run/user/1000/docker.sock'));
    expect(opens).toEqual([{ image: OWN.id, socket: '/run/user/1000/docker.sock' }]);
  });

  // WorkspaceHelper computes no socket: the worker gives its own, and the endpoint rule is helperDockerSocket's, tested
  // in helperImages.rules.test.ts.
});
