// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The VS Code of the configuration `untrusted` of .vscode-test.mjs (useInstallation): @vscode/test-electron always
// starts VS Code with --disable-workspace-trust (runTests), and with it VS Code trusts every folder. This program starts
// the VS Code that @vscode/test-electron downloaded for VSCODE_TEST_VERSION with the same arguments without that one,
// so that the folder of the test opens in Restricted Mode. @vscode/test-electron starts scripts/vscode-with-trust.sh
// (on Windows scripts/vscode-with-trust.cmd: there it starts a program other than an .exe only when it is a .cmd file),
// which starts this program with Node.js. The option --code-version of vscode-test does not reach this program: select
// the VS Code version with VSCODE_TEST_VERSION, as .vscode-test.mjs describes.
import { spawn } from 'child_process';

const { downloadAndUnzipVSCode } = await import('@vscode/test-electron');
const executable = await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION || 'stable');
const args = process.argv.slice(2).filter((arg) => arg !== '--disable-workspace-trust');
console.log(`VS Code with Workspace Trust: ${executable}`);
const vscode = spawn(executable, args, { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => vscode.kill(signal));
vscode.on('error', (error) => {
  console.error(`VS Code did not start: ${error.message}`);
  process.exit(1);
});
vscode.on('exit', (code, signal) => {
  if (signal) console.error(`VS Code ended by the signal ${signal}.`);
  process.exit(code ?? (signal ? 1 : 0));
});
