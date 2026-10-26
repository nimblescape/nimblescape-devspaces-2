// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Dev Containers asks once per user, in a modal dialog, before its first attach ("Attaching to a container may execute
// arbitrary code.", Got It), and VS Code refuses every dialog in tests. Got It stores
// userConfirmedAttachToContainerRequiresTrust in the global state of Dev Containers, but VS Code keeps the global state
// in memory while it runs tests, so the state cannot be prepared. The copy of Dev Containers in the extensions folder of
// @vscode/test-cli is changed instead: the function of the question returns true at once.
// test/vscode/attach/prepare.ts calls it after it installed Dev Containers, and scripts/run-attach-tests.mjs before each
// attach run: VS Code can install a newer Dev Containers release while a run goes on (seen with VS Code Insiders in the
// run `previous`, which sets extensions.autoUpdate to false), and the next run loads that release with its question.
// The module uses no import.meta, because scripts/build-vscode-tests.mjs bundles prepare.ts as CommonJS.
import * as fs from 'fs';
import * as path from 'path';

const FOLDER_PREFIX = 'ms-vscode-remote.remote-containers-';
// Dev Containers 0.469.0: var GA="userConfirmedAttachToContainerRequiresTrust";async function js(e){if(e.globalState.get(GA))return!0;…
// The second group is the change of an earlier call.
const QUESTION = /(="userConfirmedAttachToContainerRequiresTrust";async function [\w$]+\([\w$]+\)\{)(return!0;)?/;

/**
 * Makes the attach question return true at once in every Dev Containers folder of the extensions folder; a folder that
 * an earlier call changed stays as it is. Throws when the question is not found in a folder, or when no folder has
 * Dev Containers.
 * @param {string} extensionsDir
 * @returns {string[]} A line for the log per Dev Containers folder.
 */
export function answerAttachQuestion(extensionsDir) {
  const lines = [];
  let answered = 0;
  for (const folder of fs.readdirSync(extensionsDir).filter((name) => name.startsWith(FOLDER_PREFIX)).sort()) {
    const version = folder.slice(FOLDER_PREFIX.length);
    const file = path.join(extensionsDir, folder, 'dist', 'extension', 'extension.js');
    // VS Code removes the folder of a replaced release at its next start; an earlier run can leave it half removed.
    if (!fs.existsSync(file)) {
      lines.push(`Dev Containers ${version}: ${file} does not exist; the folder is skipped.`);
      continue;
    }
    const code = fs.readFileSync(file, 'utf8');
    const match = QUESTION.exec(code);
    if (!match) throw new Error(`The attach question was not found in ${file}.`);
    answered++;
    if (match[2]) {
      lines.push(`Dev Containers ${version}: the attach question was already answered (${file}).`);
      continue;
    }
    fs.writeFileSync(file, code.replace(QUESTION, '$1return!0;'));
    lines.push(`Dev Containers ${version}: the attach question is answered (${file}).`);
  }
  if (answered === 0) throw new Error(`Dev Containers is not installed in ${extensionsDir}.${lines.length > 0 ? `\n${lines.join('\n')}` : ''}`);
  return lines;
}
