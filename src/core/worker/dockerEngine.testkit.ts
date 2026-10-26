// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The base of every fake DockerEngine of the tests: each method fails, so that a test names only the methods that its
// flow may use, and a call of any other one fails the test.
import type { DockerEngine } from './dockerEngine';

/** A DockerEngine whose every method rejects with the name of the method; a fake overrides the ones it serves. */
export function unusedEngine(): DockerEngine {
  const unused =
    (name: string) =>
    async (): Promise<never> => {
      throw new Error(`The fake engine of this test does not serve ${name}.`);
    };
  return {
    container: unused('container'),
    containers: unused('containers'),
    // The list of the containers without an inspect.
    containerSummaries: unused('containerSummaries'),
    exec: unused('exec'),
    stop: unused('stop'),
    start: unused('start'),
    // The Monitor that ends itself.
    updateRestartPolicy: unused('updateRestartPolicy'),
    version: unused('version'),
    // The identity of the engine and the prune of the probe and the sweep.
    identity: unused('identity'),
    pruneContainers: unused('pruneContainers'),
    inspect: unused('inspect'),
    containerIds: unused('containerIds'),
    images: unused('images'),
    volumeNames: unused('volumeNames'),
    networkNames: unused('networkNames'),
    removeContainer: unused('removeContainer'),
    renameContainer: unused('renameContainer'),
    removeImage: unused('removeImage'),
    tagImage: unused('tagImage'),
    createVolume: unused('createVolume'),
    removeVolume: unused('removeVolume'),
    removeNetwork: unused('removeNetwork'),
    pull: unused('pull'),
    labelImage: unused('labelImage'),
    imageFile: unused('imageFile'),
    containerFile: unused('containerFile'),
    systemTime: unused('systemTime'),
    proxy: unused('proxy'),
    architecture: unused('architecture'),
    processes: unused('processes'),
    createAttached: unused('createAttached'),
    runAttached: unused('runAttached'),
  };
}
