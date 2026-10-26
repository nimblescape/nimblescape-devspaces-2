// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// `npm run uninstall-local`: removes the extension (the id of package.json) from the VS Code of this computer
// (`code --uninstall-extension …`), the counterpart of `npm run install-local`. It removes it from every VS Code
// profile: the default profile and each profile listed in VS Code's storage.json (userDataProfiles). A profile in which
// the extension is not installed is skipped.
// `npm run uninstall-local -- --profile <name>` removes it from that one profile only.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { name, publisher } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const id = `${publisher}.${name}`;
// code is a .cmd file on Windows, which needs a shell.
const shell = process.platform === 'win32';

/** Runs `code` with `args`. Returns "removed", "not installed" or "failed". */
function uninstall(args) {
  console.log(`> code ${args.join(' ')}`);
  // With a shell (Windows), an argument with spaces (a profile name) must be quoted.
  const shellArgs = shell ? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : args;
  const result = spawnSync('code', shellArgs, { cwd: root, encoding: 'utf8', shell });
  if (result.error) {
    console.error(`code: ${result.error.message}`);
    console.error('The command `code` was not found. In VS Code: Shell Command: Install \'code\' command in PATH.');
    process.exit(1);
  }
  const output = `${result.stdout}${result.stderr}`;
  if (result.status === 0) {
    process.stdout.write(result.stdout);
    return 'removed';
  }
  if (/is not installed/.test(output)) {
    console.log('Not installed.');
    return 'not installed';
  }
  process.stderr.write(output);
  return 'failed';
}

/** The folder of VS Code's user data (VSCODE_USER_DATA_DIR for tests), by platform. */
function userDataDir() {
  if (process.env.VSCODE_USER_DATA_DIR) return process.env.VSCODE_USER_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Code');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Code');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Code');
}

/**
 * The names of the profiles other than the default profile (userDataProfiles in VS Code's storage.json). Empty when
 * there are none or VS Code's storage cannot be read.
 */
function profileNames() {
  try {
    const storage = JSON.parse(readFileSync(join(userDataDir(), 'User', 'globalStorage', 'storage.json'), 'utf8'));
    const names = (storage?.userDataProfiles ?? []).map((profile) => profile?.name).filter((name) => typeof name === 'string' && name !== '');
    return [...new Set(names)];
  } catch {
    return [];
  }
}

const profileIndex = process.argv.indexOf('--profile');
const named = profileIndex >= 0 ? process.argv[profileIndex + 1] : undefined;
if (profileIndex >= 0 && !named) {
  console.error('--profile needs the name of a VS Code profile.');
  process.exit(1);
}
// undefined stands for the default profile.
const profiles = named ? [named] : [undefined, ...profileNames()];
console.log(`VS Code profiles: ${profiles.map((profile) => profile ?? 'Default').join(', ')}`);

const removed = [];
let failed = false;
for (const profile of profiles) {
  const outcome = uninstall(['--uninstall-extension', id, ...(profile ? ['--profile', profile] : [])]);
  if (outcome === 'removed') removed.push(profile ?? 'Default');
  if (outcome === 'failed') failed = true;
}
if (removed.length > 0) {
  console.log(`Removed ${id} from: ${removed.join(', ')}. Reload the open VS Code windows (Developer: Reload Window).`);
} else if (!failed) {
  console.log(`${id}: not installed.`);
}
if (failed) {
  console.error('VS Code could not remove the extension in every profile (see above).');
  process.exit(1);
}
