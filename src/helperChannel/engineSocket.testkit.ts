// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The worker of an end-to-end test (batch.e2e.test.ts, channel.e2e.test.ts) talks to a fake engine of the test. Never
// bundled into the extension or the worker of dist.
import * as fs from 'fs';
import type * as esbuild from 'esbuild';

/**
 * The Engine API of the worker's bundle, and the Docker streams of its relay (relay.ts), on `socketPath` in place of
 * /var/run/docker.sock (only in the build of the test; the worker and the relay have no way to choose another engine).
 */
export function engineSocketPlugin(socketPath: string): esbuild.Plugin {
  return {
    name: 'engine-socket-of-the-test',
    setup(build) {
      build.onLoad({ filter: /[\\/]helperChannel[\\/]engineApi\.ts$/ }, async (args) => {
        const text = await fs.promises.readFile(args.path, 'utf8');
        const parts = text.split('socketPath: string = HELPER_DOCKER_SOCKET');
        // The API and the hijack: a change of either must change this test too.
        if (parts.length !== 3) throw new Error('The default socket of engineApi.ts changed; the e2e tests of the worker cannot replace it.');
        return { contents: parts.join(`socketPath: string = ${JSON.stringify(socketPath)}`), loader: 'ts' };
      });
      build.onLoad({ filter: /[\\/]helperChannel[\\/]relay\.ts$/ }, async (args) => {
        const text = await fs.promises.readFile(args.path, 'utf8');
        const parts = text.split('dockerSocket: string = HELPER_DOCKER_SOCKET');
        // The parameter of startRelay.
        if (parts.length !== 2) throw new Error('The default socket of relay.ts changed; the e2e tests of the relay cannot replace it.');
        return { contents: parts.join(`dockerSocket: string = ${JSON.stringify(socketPath)}`), loader: 'ts' };
      });
    },
  };
}
