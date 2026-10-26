// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The compile-time constants of the code (src/types/globals.d.ts), as the option `define` of esbuild and vitest.
// esbuild.mjs gives them to every bundle (scripts/bundleOptions.mjs); vitest.config.mts, vitest.docker.config.mts,
// scripts/build-vscode-tests.mjs and the tests that bundle the worker give them to the tests. The only one is the
// version of the Dev Container CLI from package.json (scripts/cliVersion.mjs). The version of Devspaces is none of
// them: each program reads it at its start (src/core/http.ts), so the bundles stay the same when only the version
// changes.
import { devcontainerCliVersion } from './cliVersion.mjs';

/**
 * The constants with their values as JSON, for the option `define` of esbuild and vitest.
 * @returns {{ __DEVCONTAINER_CLI_VERSION__: string }}
 */
export function buildDefines() {
  return { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(devcontainerCliVersion()) };
}
