// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/// <reference types="mocha" />
// Tests of the configuration `untrusted` (.vscode-test.mjs, npm run test:vscode:vsix): VS Code runs the packaged VSIX in
// a local folder that it does not trust (Restricted Mode). The manifest declares limited support
// (capabilities.untrustedWorkspaces), so VS Code runs the extension there, and ignores the values of the folder for the
// settings in restrictedConfigurations: only the user settings and the defaults apply. The tests of
// test/vscode/extension.test.ts run in the same window before these (activation, the commands of the manifest, and a
// log without errors).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import * as vscode from 'vscode';

const EXTENSION_ID = 'nimblescape.nimblescape-devspaces-2';

interface Manifest {
  capabilities: { untrustedWorkspaces: { supported: unknown; restrictedConfigurations: string[] } };
  contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
}

/** The settings in a settings.json file that .vscode-test.mjs wrote (plain JSON, without comments). */
function settingsFile(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function manifest(): Manifest {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not loaded`);
  return extension.packageJSON as Manifest;
}

/** The settings of the folder of the window (.vscode/settings.json). */
function folderSettings(): Record<string, unknown> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  assert.strictEqual(folders.length, 1, 'The window has not one folder (.vscode-test.mjs, workspaceFolder)');
  return settingsFile(path.join(folders[0].uri.fsPath, '.vscode', 'settings.json'));
}

/** The user settings of the test VS Code. */
function userSettings(): Record<string, unknown> {
  const userDataDir = process.env.DEVSPACE_TEST_USER_DATA_DIR;
  assert.ok(userDataDir, 'DEVSPACE_TEST_USER_DATA_DIR is not set (.vscode-test.mjs)');
  return settingsFile(path.join(userDataDir, 'User', 'settings.json'));
}

/**
 * The value of `key` (`<section>.<name>`) that the extension gets from VS Code, as plain JSON: VS Code gives objects and
 * lists as read-only copies.
 */
function settingValue(key: string): unknown {
  const dot = key.lastIndexOf('.');
  const value = vscode.workspace.getConfiguration(key.slice(0, dot)).get<unknown>(key.slice(dot + 1));
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

describe('the extension in a folder that VS Code does not trust', () => {
  it('opens the folder in Restricted Mode', () => {
    assert.strictEqual(process.env.DEVSPACE_TEST_CONFIGURATION, 'untrusted', 'DEVSPACE_TEST_CONFIGURATION is not untrusted (.vscode-test.mjs)');
    assert.strictEqual(vscode.workspace.isTrusted, false, 'VS Code trusts the folder of the test');
  });

  // VS Code does not load an extension without this support in Restricted Mode (getExtension gives undefined).
  it('runs the extension, which declares limited support', async () => {
    assert.strictEqual(manifest().capabilities.untrustedWorkspaces.supported, 'limited');
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
  });

  it('uses the settings of the folder that Restricted Mode does not limit', () => {
    const folder = folderSettings();
    assert.strictEqual(folder['editor.tabSize'], 3);
    assert.strictEqual(settingValue('editor.tabSize'), 3);
  });

  it('ignores the values of the folder for the restricted settings: the user value or the default applies', () => {
    const { contributes, capabilities } = manifest();
    const restricted = capabilities.untrustedWorkspaces.restrictedConfigurations;
    const folder = folderSettings();
    const user = userSettings();
    // The files of .vscode-test.mjs must still give every restricted setting a folder value other than its default, and
    // one of them a user value, or the test would prove nothing.
    for (const key of restricted) {
      assert.ok(key in folder, `The folder of the test does not set ${key}`);
      assert.notDeepStrictEqual(folder[key], contributes.configuration.properties[key]?.default, `The folder of the test sets ${key} to its default`);
    }
    assert.ok(
      restricted.some((key) => key in user && !isDeepStrictEqual(user[key], folder[key])),
      'The user settings of the test give no restricted setting a value of their own',
    );
    const used = restricted.map((key) => ({ key, value: settingValue(key) }));
    const expected = restricted.map((key) => ({ key, value: key in user ? user[key] : contributes.configuration.properties[key]?.default }));
    assert.deepStrictEqual(used, expected);
  });
});
