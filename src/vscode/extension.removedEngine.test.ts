// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// On an engine with the removal mark of "Remove Devspaces from This Docker Engine…" (docker-engines.json), this computer
// does no Docker work by itself. The gates are in the wiring of extension.ts, which cannot be loaded without VS Code:
// they are read from its source here; what they guard is tested where it lives (src/core/helperChannel for checkPresent
// and onRefreshWithoutHelper, src/core/session/heartbeatWiring.test.ts, src/core/helper for the stops).
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');

describe('the gates of extension.ts on an engine with the removal mark', () => {
  // The refresh of the sidebar starts no worker there (its mounts would create the shared volumes again): the check of
  // the helper image refuses it first. Mutation: without the check, the refresh opens the worker there.
  it('the refresh starts no worker there: checkPresent refuses the engine before it checks the helper image', () => {
    expect(source).toMatch(
      /checkPresent: async \(target, signal\) => \{\s*if \(await engineRemoved\(target\)\) throw new Error\(removedEngineNote\(describeDockerHost\(target\.host\)\)\);\s*await runWithDockerTarget\(target, \(\) => helper\.checkImagePresent\(\{ signal \}\)\);\s*\}/,
    );
  });

  // A refresh that finds no helper image asks for its background build, never on such an engine. Mutation: without the
  // check, the build of the image starts there.
  it('a refresh that finds no helper image there asks for no background build', () => {
    expect(source).toMatch(
      /onRefreshWithoutHelper: \(target\) => \{\s*void engineRemoved\(target\)\.then\(\(removed\) => \(removed \? undefined : helperBuilds\.request\(target\)\)\);\s*\}/,
    );
  });

  it('a heartbeat prepares no worker there: heartbeatWiring gets the mark', () => {
    expect(source).toMatch(/const heartbeats = heartbeatWiring\(\{[^}]*\n\s*engineRemoved,\n/);
  });

  // The removal stops both background builds of the helper image on its engine before it removes the images
  // (HelperPrebuild.stop and MissingHelperBuild.stop, tested in src/core/helper).
  it('the removal stops the background prebuild and the build of a missing helper image on its engine', () => {
    expect(source).toMatch(/stopHelperBuilds: async \(target\) => \{\s*await Promise\.all\(\[backgroundPrebuild\?\.stop\(target\), helperBuilds\.stop\(target\)\]\);\s*\}/);
    expect(source).toMatch(/const helperPrebuild = new HelperPrebuild\(\{[\s\S]*?\n  context\.subscriptions\.push\(helperPrebuild\);\n  backgroundPrebuild = helperPrebuild;\n/);
  });
});
