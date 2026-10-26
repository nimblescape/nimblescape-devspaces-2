// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The tests in a real VS Code: @vscode/test-cli downloads VS Code to .vscode-test/, installs the Dev Containers
// extension (extensionDependencies) there, starts VS Code with an empty user data folder, and runs the bundled tests of
// out/test/vscode/ with mocha in its extension host. The configurations:
// - "vscode" (npm run test:vscode): the extension of the development build in dist/.
// - "vsix" (npm run test:vscode:vsix, after npm run package): the packaged VSIX of the version in package.json, as
//   users install it. VS Code loads only the small folder test/vscode/host as development extension, because a
//   development extension with the ID of the installed VSIX would be loaded in its place.
// - "untrusted" (npm run test:vscode:vsix, after "vsix"): the packaged VSIX in a local folder that VS Code does not
//   trust (Restricted Mode), with the tests of test/vscode/untrusted/ too.
// - "attach" (CI only, npm run test:vscode:attach after npm run test:vscode:attach:prepare): VS Code starts in the
//   window of a container that test/vscode/attach/prepare.ts made on the real Docker engine, and runs the tests of
//   test/vscode/attach/<kind>.test.ts there. It exists only when DEVSPACE_TEST_ATTACH names the kind (plain,
//   devspace, reattach: the devspace again after a restart of VS Code, account: the devspace under another GitHub
//   account, longopen: the devspace with an open pipeline of several minutes, remote: a devspace on the Docker engine
//   of another computer over SSH, stopped: a local folder, whose tests start a second VS Code in the window of the
//   devspace and stop and remove its container, previous: the devspace with the last released version of the
//   extension, or updated: the devspace again after the update to the VSIX of this checkout), so that no local run
//   reaches the Docker engine of this computer.
// VSCODE_TEST_VERSION selects the VS Code version: "stable" (the default), "insiders", a version such as 1.125.0, or the
// commit of an Insiders build (the attach jobs of CI pin Insiders so). On Linux without a display, run it under xvfb-run.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from '@vscode/test-cli';

const manifest = JSON.parse(fs.readFileSync(new URL('package.json', import.meta.url), 'utf8'));
const vsix = fileURLToPath(new URL(`${manifest.name}-${manifest.version}.vsix`, import.meta.url));

// The extension of the test window must never reach the Docker engine of this computer: with a fresh user data
// folder it would build the helper image in the background and restore devspaces from the volumes there. DOCKER_HOST
// decides over the Docker context (src/core/docker/dockerTargets.ts), and nothing listens at this address, so the
// extension finds Docker not running. Windows has named pipes where other systems have Unix sockets.
const dockerHost =
  process.platform === 'win32'
    ? 'npipe:////./pipe/nimblescape-devspaces-vscode-test'
    : 'unix:///nonexistent/nimblescape-devspaces-vscode-test.sock';

/**
 * The labels that `vscode-test --label <label>` runs: every value after `--label` or `-l` up to the next option, and of
 * `--label=`; a number is the index of a configuration (the Extension Test Runner of VS Code passes the index). Empty
 * without a label: then every configuration runs. `--list-configuration` (the Extension Test Runner calls it) runs
 * nothing, so it removes no folder.
 */
const args = process.argv.slice(2);
const listsOnly = args.includes('--list-configuration');
const selectedLabels = [];
for (let index = 0; index < args.length; index++) {
  if (args[index].startsWith('--label=')) selectedLabels.push(args[index].slice('--label='.length));
  if (args[index] !== '--label' && args[index] !== '-l') continue;
  while (index + 1 < args.length && !args[index + 1].startsWith('-')) selectedLabels.push(args[++index]);
}
/** Tells the user data folders of two checkouts on one computer apart. */
const checkout = fileURLToPath(new URL('.', import.meta.url));
const checkoutId = crypto.createHash('sha256').update(checkout).digest('hex').slice(0, 6);

/** True when this run of vscode-test runs the configuration `label` with the index `index`. */
function isSelected(label, index) {
  return selectedLabels.length === 0 || selectedLabels.includes(label) || selectedLabels.includes(`${index}`);
}

/** Writes `value` as JSON into `file`, with its folder. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/**
 * A configuration with its own empty user data folder: the folder is removed before each run of the configuration
 * (the default of @vscode/test-electron keeps it between runs), so the extension starts as after a fresh installation
 * on every computer, as on CI. Its path has a space and a letter outside ASCII, as the user folder of many users has.
 * It is in the temporary folder of the system, because VS Code puts its socket into the user data folder, and macOS
 * allows at most 103 bytes in a socket path, which a folder below a checkout often exceeds. The downloaded VS Code and
 * the installed extensions in .vscode-test/ stay.
 */
function configuration(label, index, options, { keepUserDataDir = false } = {}) {
  const userDataDir = path.join(os.tmpdir(), `devspaces ${label} ü ${checkoutId}`);
  if (!listsOnly && isSelected(label, index) && !keepUserDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  return {
    label,
    files: 'out/test/vscode/*.test.js',
    version: process.env.VSCODE_TEST_VERSION || 'stable',
    // The empty user data folder, no workspace trust prompt, no first-run pages, and on Linux secrets in a file
    // instead of a keyring, which a CI runner or a container does not have.
    launchArgs: [
      `--user-data-dir=${userDataDir}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--password-store=basic',
    ],
    // DEVSPACE_TEST_USER_DATA_DIR: the tests read the log of the extension from the logs folder of VS Code there.
    // DEVSPACE_TEST_CONFIGURATION and DEVSPACE_TEST_VERSION: the tests check that VS Code runs the extension from the
    // build of this label, of the version of this checkout.
    env: {
      DOCKER_HOST: dockerHost,
      DEVSPACE_TEST_USER_DATA_DIR: userDataDir,
      DEVSPACE_TEST_CONFIGURATION: label,
      DEVSPACE_TEST_VERSION: manifest.version,
    },
    mocha: {
      ui: 'bdd',
      // The first activation of the extension in a fresh VS Code can be slow on CI runners.
      timeout: 60_000,
    },
    ...options,
  };
}

/**
 * The configuration `attach`: the window of the container DEVSPACE_TEST_ATTACH of out/test/vscode/attach/seed.json, on
 * the Docker engine of this computer (`remote`: of the other computer that the current Docker context names). The fake
 * sign-in provider `github` (test/vscode/github) replaces the built-in one.
 * `reattach`, `account` and `longopen` start VS Code again in the window of the devspace with the user data folder of
 * the run `devspace`, as a restart of VS Code; `account` with another signed-in account than the owner of the devspace.
 * `longopen` starts as long after the last open: without the pending connection files of the extension. The runs before
 * usually remove them already; this makes sure that the window runs the open pipeline again (src/vscode/
 * activationRules.ts, pipelineJustRan).
 * `previous` and `updated` (a CI job of their own, prepare.ts with DEVSPACE_TEST_ATTACH_PREPARE=update) load the
 * extension that is installed in the extensions folder of the test VS Code, not the build of this checkout: `previous`
 * the last released version from the VSIX of its GitHub release, with a fresh user data folder where VS Code updates no
 * extension;
 * `updated` the VSIX of this checkout that CI installed over it (scripts/install-attach-extensions.mjs), with the user
 * data folder of `previous` and as long after the last open (like `longopen`), so that the window runs the open
 * pipeline of the new version, as at the first start of VS Code some time after an update. VS Code loads only the small
 * folder test/vscode/host and the sign-in provider as development extensions, as in the configuration `vsix`.
 */
function attachConfiguration(kind, index) {
  const restart = kind === 'reattach' || kind === 'account' || kind === 'longopen' || kind === 'stopped' || kind === 'updated';
  const update = kind === 'previous' || kind === 'updated';
  const container = restart || update ? 'devspace' : kind;
  const seed = JSON.parse(fs.readFileSync(new URL('out/test/vscode/attach/seed.json', import.meta.url), 'utf8'))[container];
  if (!seed) throw new Error(`out/test/vscode/attach/seed.json has no container "${container}".`);
  const base = configuration('attach', index, {}, { keepUserDataDir: restart });
  const userSettings = path.join(base.env.DEVSPACE_TEST_USER_DATA_DIR, 'User', 'settings.json');
  if (kind === 'previous' && !listsOnly) writeJson(userSettings, { 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false });
  if ((kind === 'longopen' || kind === 'updated') && !listsOnly) {
    const pending = path.join(base.env.DEVSPACE_TEST_USER_DATA_DIR, 'User', 'globalStorage', `${manifest.publisher}.${manifest.name}`, 'pending');
    for (const name of fs.existsSync(pending) ? fs.readdirSync(pending) : []) fs.rmSync(path.join(pending, name), { force: true });
  }
  // `plain` starts as after the first use of Devspaces (the empty marker `used`, src/core/storage/firstUse.ts), so that
  // the window of a container that is no devspace restores the devspaces from the volumes while it activates, as the
  // tests of test/vscode/attach/plain.test.ts expect; with a fresh user data folder alone, it would restore nothing.
  if (kind === 'plain' && !listsOnly) {
    const storage = path.join(base.env.DEVSPACE_TEST_USER_DATA_DIR, 'User', 'globalStorage', `${manifest.publisher}.${manifest.name}`);
    fs.mkdirSync(storage, { recursive: true });
    fs.writeFileSync(path.join(storage, 'used'), '');
  }
  const extensionDevelopmentPath = [update ? fileURLToPath(new URL('test/vscode/host', import.meta.url)) : checkout, fileURLToPath(new URL('test/vscode/github', import.meta.url))];
  // `stopped` starts with a local folder; its tests start a second VS Code in the window of the devspace
  // (test/vscode/attach/stopped.test.ts): with an empty user data folder of its own (VS Code puts its socket there, so
  // the path is short), the extensions folder of the test VS Code (@vscode/test-electron, getProfileArguments), where
  // CI installed the extension and the sign-in provider from their VSIX files (scripts/install-attach-extensions.mjs),
  // and the arguments of the test VS Code (@vscode/test-electron, runTests), without tests and without development
  // extensions.
  const local = path.join(os.tmpdir(), `devspaces attach local ${checkoutId}`);
  const second = path.join(os.tmpdir(), `devspaces second ${checkoutId}`);
  const extensionsDir = path.join(checkout, '.vscode-test', 'extensions');
  if (kind === 'stopped' && !listsOnly) {
    fs.mkdirSync(local, { recursive: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
  const secondVscode = {
    userDataDir: second,
    extensionsDir,
    args: [
      `--user-data-dir=${second}`,
      `--extensions-dir=${extensionsDir}`,
      `--folder-uri=${seed.folderUri}`,
      '--disable-extension=vscode.github-authentication',
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-updates',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--password-store=basic',
    ],
  };
  return {
    ...base,
    files: `out/test/vscode/attach/${kind}.test.js`,
    extensionDevelopmentPath,
    ...(kind === 'stopped' ? { workspaceFolder: local } : {}),
    launchArgs: [...base.launchArgs, ...(kind === 'stopped' ? [] : [`--folder-uri=${seed.folderUri}`]), '--disable-extension=vscode.github-authentication'],
    env: {
      DEVSPACE_TEST_USER_DATA_DIR: base.env.DEVSPACE_TEST_USER_DATA_DIR,
      DEVSPACE_TEST_ATTACH: kind,
      DEVSPACE_TEST_ATTACH_SEED: JSON.stringify(seed),
      ...(kind === 'account' ? { DEVSPACE_TEST_GITHUB_ACCOUNT: JSON.stringify({ id: '9999', label: 'devspaces-other' }) } : {}),
      ...(kind === 'stopped' ? { DEVSPACE_TEST_SECOND_VSCODE: JSON.stringify(secondVscode) } : {}),
    },
    // The longest wait of a test is one minute (postAttachCommand); the tests of `stopped` set their own.
    mocha: { ...base.mocha, timeout: 120_000 },
  };
}

/** The packaged VSIX, as users install it (the configurations `vsix` and `untrusted`). */
const vsixOptions = {
  extensionDevelopmentPath: fileURLToPath(new URL('test/vscode/host', import.meta.url)),
  // The test host folder has no extensionDependencies, so the Dev Containers extension is named here.
  installExtensions: ['ms-vscode-remote.remote-containers', vsix],
};

/**
 * The configuration `untrusted`: the packaged VSIX, as in `vsix`, in a local folder that VS Code does not trust
 * (Restricted Mode). @vscode/test-electron always starts VS Code with --disable-workspace-trust, so VS Code starts
 * through scripts/vscode-with-trust.sh (on Windows scripts/vscode-with-trust.cmd) and scripts/vscode-with-trust.mjs,
 * which leaves that argument out, and the user setting security.workspace.trust.startupPrompt "never" opens the folder
 * in Restricted Mode without a question. The settings of the folder give each setting that the manifest lists in
 * capabilities.untrustedWorkspaces.restrictedConfigurations a value other than its default, and set editor.tabSize, a
 * setting of VS Code that Restricted Mode does not limit; the user settings give one of the listed settings a value
 * too. test/vscode/untrusted/untrusted.test.ts reads both files and checks the values that the extension gets.
 */
function untrustedConfiguration(index) {
  const base = configuration('untrusted', index, vsixOptions);
  const folder = path.join(os.tmpdir(), `devspaces untrusted folder ${checkoutId}`);
  if (isSelected('untrusted', index) && !listsOnly) {
    fs.rmSync(folder, { recursive: true, force: true });
    writeJson(path.join(folder, '.vscode', 'settings.json'), {
      'editor.tabSize': 3,
      'devspaces.reopenLastOnStartup': false,
      'devspaces.updateImagesOnConnect': false,
      'devspaces.owners': ['devspaces-folder-owner'],
      'devspaces.includeArchived': true,
      'devspaces.includeForks': false,
      'devspaces.showOnlyDevspaces': true,
      'devspaces.refreshIntervalMinutes': 45,
    });
    writeJson(path.join(base.env.DEVSPACE_TEST_USER_DATA_DIR, 'User', 'settings.json'), {
      'security.workspace.trust.startupPrompt': 'never',
      'devspaces.refreshIntervalMinutes': 30,
    });
  }
  const launcher = `scripts/vscode-with-trust.${process.platform === 'win32' ? 'cmd' : 'sh'}`;
  return {
    ...base,
    files: [base.files, 'out/test/vscode/untrusted/*.test.js'],
    useInstallation: { fromPath: fileURLToPath(new URL(launcher, import.meta.url)) },
    workspaceFolder: folder,
    launchArgs: base.launchArgs.filter((arg) => arg !== '--disable-workspace-trust'),
  };
}

const attachKind = process.env.DEVSPACE_TEST_ATTACH;

export default defineConfig([
  configuration('vscode', 0, {}),
  configuration('vsix', 1, vsixOptions),
  untrustedConfiguration(2),
  ...(attachKind ? [attachConfiguration(attachKind, 3)] : []),
]);
