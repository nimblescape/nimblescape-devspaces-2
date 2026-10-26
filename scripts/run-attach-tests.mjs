// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Runs the attach tests (`vscode-test --label attach`, npm run test:vscode:attach) and fails unless mocha reported a
// result without failures. VS Code can end a test run with exit code 0 and without a mocha summary: when the remote
// connection of the window drops during a test, the extension host in the container ends, and VS Code then ends the
// whole test run with the exit code of that extension host ("Extension host test runner error { name: 'Canceled' }",
// seen in PR #18; AbstractExtensionService, _onExtensionHostExit). A failed test then counts as passed. So the output
// must have a line "<n> passing", and no line "<n> failing" or "<n>) <test>" of a failed test. A window that reloads
// during the run (the run `account`) prints its summary in the run after the reload.
// Before the run, the Dev Containers releases in the extensions folder of the test VS Code lose their attach question
// (scripts/attachQuestion.mjs), also a release that VS Code installed during an earlier run. After it, the programs
// that the test VS Code left running are listed, and the run fails when one of the extension that started during the
// run still runs WAIT_MS after the quit (scripts/leftoverPrograms.mjs); in the run `previous`, whose extension is the
// last released version, they are only listed.
import { spawn } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { answerAttachQuestion } from './attachQuestion.mjs';
import { WAIT_MS, reportLeftoverPrograms, uptimeSeconds } from './leftoverPrograms.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'node_modules', '@vscode', 'test-cli', 'out', 'bin.mjs');

for (const line of answerAttachQuestion(path.join(root, '.vscode-test', 'extensions'))) console.log(line);

const since = uptimeSeconds();
const child = spawn(process.execPath, [cli, '--label', 'attach', ...process.argv.slice(2)], { stdio: ['inherit', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (data) => {
  output += data.toString();
  process.stdout.write(data);
});
child.stderr.on('data', (data) => {
  output += data.toString();
  process.stderr.write(data);
});
child.on('error', (error) => {
  console.error(`vscode-test could not be started: ${String(error)}`);
  process.exit(1);
});
child.on('close', async (code, signal) => {
  const leftover = await reportLeftoverPrograms({ since });
  if (code !== 0) {
    console.error(`vscode-test ended with ${code === null ? `the signal ${signal}` : `exit code ${code}`}.`);
    process.exit(code ?? 1);
  }
  const problems = [];
  if (!/^\s+\d+ passing/m.test(output)) problems.push('mocha reported no result (no line "<n> passing"): the test run did not end normally');
  if (/^\s+\d+ failing/m.test(output)) problems.push('mocha reported failed tests');
  else if (/^[ \t]+\d+\) \S/m.test(output)) problems.push('a test failed, and its run ended without a summary');
  if (problems.length > 0) {
    console.error(`The attach tests failed although VS Code ended with exit code 0: ${problems.join('; ')}.`);
    process.exit(1);
  }
  if (leftover.length > 0 && process.env.DEVSPACE_TEST_ATTACH !== 'previous') {
    console.error(`${leftover.length} programs of the extension still ran ${WAIT_MS / 1000} s after VS Code quit (listed above).`);
    process.exit(1);
  }
});
