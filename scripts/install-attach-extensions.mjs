// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// CI only, before the attach runs `stopped` and `updated` (.github/workflows/ci.yml): packages the extension (npm run
// package, which also makes the production build in dist/) and the test sign-in provider (test/vscode/github) and
// installs both from their VSIX files into the extensions folder of the test VS Code, as users install an extension, also
// over an installed version of the same or a lower version (the run `updated`). packaged.json next to the VSIX files
// names the version and the SHA-256 of the packaged dist/extension.js, so that the run `updated` can check that VS Code
// loads this build (test/vscode/attach/updated.test.ts). The second VS Code of the run `stopped` (test/vscode/attach/stopped.test.ts)
// loads both from the extensions folder. It cannot load them as development extensions (--extensionDevelopmentPath):
// VS Code closes a window of development extensions when one of its extension hosts ends, and the extension host of the
// container ends when the container stops (seen in PR #18; VS Code, AbstractExtensionService, _onExtensionHostExit).
// The test VS Code loads its development extensions in place of the installed ones with the same IDs.
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVSIX } from '@vscode/vsce';

const root = fileURLToPath(new URL('..', import.meta.url));
// @vscode/test-electron takes its folder .vscode-test from the current folder when it loads.
process.chdir(root);
const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = await import('@vscode/test-electron');
const folder = path.join(root, 'out', 'test', 'vscode', 'attach', 'vsix');
const extension = path.join(folder, 'nimblescape-devspaces.vsix');
const github = path.join(folder, 'devspaces-vscode-test-github.vsix');

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ended with exit code ${result.status}.`);
}

fs.rmSync(folder, { recursive: true, force: true });
fs.mkdirSync(folder, { recursive: true });
run('npm', ['run', '-s', 'package', '--', '--out', extension]);
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extensionSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'dist', 'extension.js'))).digest('hex');
fs.writeFileSync(path.join(folder, 'packaged.json'), JSON.stringify({ version, extensionSha256 }, null, 2));
console.log(`Packaged version ${version} (dist/extension.js ${extensionSha256}).`);
// The folder has no repository field and no license file of its own.
await createVSIX({ cwd: path.join(root, 'test', 'vscode', 'github'), packagePath: github, dependencies: false, allowMissingRepository: true, skipLicense: true });

// The extensions folder of @vscode/test-electron (.vscode-test/extensions), where prepare.ts installed Dev Containers.
const executable = await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION || 'stable');
const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);
// --force: the CLI needs it only to install over a newer version, a downgrade that prepare.ts refuses for the run `updated`.
run(cli, [...cliArgs, '--install-extension', extension, '--install-extension', github, '--force']);
