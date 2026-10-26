// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { GITHUB_GRAPHQL_URL } from '../core/discovery/githubApi';
import { SHARED_VOLUMES, uninstallCommands } from '../core/docker/engineRemoval';
import { StateTexts } from '../core/messages';
import { REMOTE_MONITOR_CONTAINER } from '../core/remoteMonitor/protocol';
import { GITHUB_PROVIDER_ID, GITHUB_SCOPES, PACKAGES_SCOPES } from './auth';
import { Commands } from './commands';
import { ControllerTexts } from './controllerTexts';
import { OUTPUT_CHANNEL_NAME } from './logger';
import { OPEN_LINK_PATH, REPOSITORY_PARAMETER } from './links';
import { GITHUB_ENTERPRISE_SECTION } from './settings';
import { TreeTexts } from './treeModel';

// The top of the description and of the README (the Marketplace page) says what Devspaces does on the computer, with
// a link to docs/security.md. The scopes come from the code, so a change of the scopes also changes these texts.
const ROOT = path.join(__dirname, '..', '..');
const HEADING = 'What Devspaces does on your computer';
const SECURITY_LINK = 'https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/docs/security.md#what-devspaces-does-on-your-computer';
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
// What a start of VS Code does before the first devspace, and that a registry is asked without a login first.
const FIRST_USE_AND_LOGINS = ['Before your first devspace, Devspaces only reads the current Docker context when VS Code starts.', 'first without a login'];
// The background container: the question before it keeps running, its end after 30 days, and the command that removes
// it (the title in package.json).
const REMOVE_COMMAND = 'Remove Devspaces from This Docker Engine…';
const BACKGROUND_CONTAINER = ['Devspaces asks whether this container keeps running', '30 days', `**Devspaces: ${REMOVE_COMMAND}**`];

/** The text of the section `## <heading>` up to the next `## ` heading. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  expect(start, `the section "${heading}"`).toBeGreaterThan(0);
  const end = markdown.indexOf('\n## ', start + 1);
  return markdown.slice(start, end < 0 ? undefined : end);
}

/** The item of a list that starts with `- <start>`, with its nested items, up to the next item of the same level. */
function item(markdown: string, start: string): string {
  const begin = markdown.indexOf(`\n- ${start}`);
  expect(begin, `the item "${start}"`).toBeGreaterThanOrEqual(0);
  const end = markdown.indexOf('\n- ', begin + 1);
  return markdown.slice(begin, end < 0 ? undefined : end);
}

describe('the behaviors of Devspaces at the top of the Marketplace page', () => {
  it('opens the README with the section, which names every scope and links docs/security.md', () => {
    const readme = read('README.md');
    expect(readme.match(/^## .*$/m)?.[0]).toBe(`## ${HEADING}`);
    const text = section(readme, HEADING);
    for (const scope of PACKAGES_SCOPES) expect(text).toContain(`\`${scope}\``);
    const behaviors = ['Docker CLI', 'Dev Containers CLI', '`ssh`', 'docker-credential-', 'install', 'devspaces-monitor', 'VS Code Server', 'extensions', ...FIRST_USE_AND_LOGINS, ...BACKGROUND_CONTAINER];
    for (const words of behaviors) {
      expect(text).toContain(words);
    }
    expect(text).toContain(`(${SECURITY_LINK})`);
  });

  // When Devspaces works without a click: the activation of every window, the background work after the first
  // devspace, the reopen at startup and the hourly GitHub refresh. The texts name the defaults of the manifest.
  it('says when Devspaces works, with the activation and the defaults of the manifest', () => {
    const { activationEvents, contributes } = JSON.parse(read('package.json')) as {
      activationEvents: string[];
      contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
    };
    expect(activationEvents).toContain('onStartupFinished');
    const defaults = contributes.configuration.properties;
    expect(defaults['devspaces.reopenLastOnStartup']?.default).toBe(true);
    expect(defaults['devspaces.updateImagesOnConnect']?.default).toBe(true);
    expect(defaults['devspaces.refreshIntervalMinutes']?.default).toBe(60);
    const readme = section(read('README.md'), HEADING);
    const readmeWhen = item(readme, '**When it works.**');
    for (const words of ['Devspaces starts with every VS Code window', 'the window that you closed last was connected to a devspace', 'restores the window of a devspace', 'every hour by default']) {
      expect(readmeWhen).toContain(words);
    }
    for (const words of ['Dockerfile and the Features', '`docker exec`']) expect(item(readme, '**Background container.**')).toContain(words);
    const security = read('docs/security.md');
    const behaviors = section(security, HEADING);
    const when = item(behaviors, '**When.**');
    for (const words of ['`devspaces.reopenLastOnStartup`', '`devspaces.updateImagesOnConnect`', '`devspaces.refreshIntervalMinutes`', '(60 by default)', 'BatchMode=yes', 'restores the window of a devspace', `**Devspaces: ${REMOVE_COMMAND}**`]) {
      expect(when).toContain(words);
    }
    for (const words of ['Dockerfile and the Features', '`docker exec`']) expect(item(behaviors, '**Background container.**')).toContain(words);
    expect(section(security, 'Stored data')).toContain('`computer.id`');
  });

  // A link, for example on a website, starts a repository (links.ts): the README, Security and the user guide name the
  // link of the code, with the ID of the manifest, and the question of VS Code before it.
  it('says that a link starts a repository, with the link of the code', () => {
    const { publisher, name } = JSON.parse(read('package.json')) as { publisher: string; name: string };
    const link = `vscode://${publisher}.${name}${OPEN_LINK_PATH}?${REPOSITORY_PARAMETER}=owner/name`;
    const readmeWhen = item(section(read('README.md'), HEADING), '**When it works.**');
    const securityWhen = item(section(read('docs/security.md'), HEADING), '**When.**');
    for (const text of [readmeWhen, securityWhen]) {
      expect(text).toContain(`\`${link}\``);
      expect(text).toContain('"Do not ask me again for this extension"');
    }
    const guide = section(read('docs/guide.md'), 'Open from a link');
    expect(guide).toContain(`<a href="${link}">`);
    expect(guide).toContain('**Do not ask me again for this extension**');
  });

  it('has the section in docs/security.md, as the target of the link', () => {
    const text = section(read('docs/security.md'), HEADING);
    for (const scope of PACKAGES_SCOPES) expect(text).toContain(`\`${scope}\``);
    for (const words of ['`ssh`', 'docker-credential-', '#registry-access', ...FIRST_USE_AND_LOGINS]) expect(text).toContain(words);
    expect(text).toContain('guide.md#installing-docker');
  });

  it('has the section Uninstall in the README after Security and privacy, with the command and the shared volumes', () => {
    const readme = read('README.md');
    const headings = [...readme.matchAll(/^## (.*)$/gm)].map((match) => match[1]);
    expect(headings.indexOf('Uninstall')).toBeGreaterThan(headings.indexOf('Security and privacy'));
    expect(headings.indexOf('Security and privacy')).toBeGreaterThan(0);
    const text = section(readme, 'Uninstall');
    expect(text).toContain(`**Devspaces: ${REMOVE_COMMAND}**`);
    for (const volume of SHARED_VOLUMES) expect(text).toContain(`\`${volume}\``);
    expect(text).toContain('(https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/docs/guide.md#uninstall)');
  });

  it('has the section Uninstall in the user guide, with the commands that the log names and the Docker contexts', () => {
    const { contributes } = JSON.parse(read('package.json')) as { contributes: { commands: Array<{ command: string; title: string }> } };
    expect(contributes.commands.find((command) => command.command === 'devspaces.removeFromDockerEngine')?.title).toBe(REMOVE_COMMAND);
    const guide = read('docs/guide.md');
    expect(guide).toContain('[Uninstall](#uninstall)');
    const text = section(guide, 'Uninstall');
    expect(text).toContain(`**Devspaces: ${REMOVE_COMMAND}**`);
    for (const volume of SHARED_VOLUMES) expect(text).toContain(`\`${volume}\``);
    for (const command of uninstallCommands()) expect(text).toContain(command);
    for (const words of ['docker context rm', 'Devspaces: remote Docker host', 'globalStorage/nimblescape.nimblescape-devspaces-2']) expect(text).toContain(words);
  });

  it('names the scopes, Docker, the Dev Containers CLI and the background container in the description', () => {
    const { description } = JSON.parse(read('package.json')) as { description: string };
    for (const scope of GITHUB_SCOPES) expect(description).toContain(scope);
    for (const words of ['Docker', 'Dev Containers CLI', 'install Docker', 'background container', 'Before your first devspace', 'asks before the background container keeps running', 'a command removes it']) {
      expect(description).toContain(words);
    }
  });
});

describe('the texts of the Monitor question and of the removal in the docs', () => {
  // A placeholder such as <engine> outside code is a raw tag for Markdown, which hides it. markdownPages.test.ts refuses
  // a raw tag in the README, the change log and every page of docs/.
  it('show placeholders such as <engine> as code, and quote the texts of the code', () => {
    const guide = read('docs/guide.md');
    const question = guide.slice(guide.indexOf('The first time that you start a devspace on a Docker engine'), guide.indexOf('A monitor that keeps running ends itself'));
    expect(question).toContain('running on `<engine>`?');
    const uninstall = section(guide, 'Uninstall');
    expect(uninstall).toContain('"Remove Devspaces from `<engine>`?"');
    // The second question, with one devspace and with several, and the state of a devspace that you kept there.
    for (const count of [1, 2]) expect(uninstall).toContain(`"${ControllerTexts.removeDevspacesQuestion(count, '`<engine>`')}"`);
    for (const engine of ['Docker', '<host>']) expect(uninstall).toContain(`\`${StateTexts.unknown} (${TreeTexts.unknownShort(engine, 'removed')})\``);
    const release = section(read('CHANGELOG.md'), '0.1.0');
    for (const start of ['**Background container:**', `**${REMOVE_COMMAND}:**`]) expect(release).toContain(`\n\n${start}`);
  });

  // The mode of a running Monitor changes only at the next ensure on its engine (a start of a devspace, or Update All
  // Images Now); the answer Keep Running writes the value that the setting has while the question comes. The setting
  // has a short description (settings.test.ts): it names the question and links to the section of the guide that says
  // the rest, also what happens on an engine that several computers use.
  it('the guide says when a changed answer reaches a running Monitor, and the setting links to that section', () => {
    const { contributes } = JSON.parse(read('package.json')) as { contributes: { configuration: { properties: Record<string, { markdownDescription?: string }> } } };
    const setting = contributes.configuration.properties['devspaces.stopMonitorWhenIdle'];
    const guide = read('docs/guide.md');
    const changed = 'A change applies on each engine at the next start of a devspace or **Update All Images Now** there.';
    const shared =
      'On an engine that several computers use, a monitor that keeps running and that another computer created stays; the computer that created it replaces it when it turns the setting on (see [Shared Docker engines](#shared-docker-engines)).';
    expect(setting?.markdownDescription).toContain('the first Start or Rebuild on an engine, or **Update All Images Now** there, asks');
    expect(setting?.markdownDescription).toContain('(https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/docs/guide.md#the-background-run)');
    const start = guide.indexOf('\n### The background run\n');
    expect(start, 'the section "The background run"').toBeGreaterThan(0);
    const backgroundRun = guide.slice(start, guide.indexOf('\n### ', start + 1));
    for (const words of [changed, 'removes it at once', 'It does not ask while `devspaces.stopMonitorWhenIdle` is on.', shared]) expect(backgroundRun).toContain(words);
    expect(guide).toContain('\n## Shared Docker engines\n');
    // The row of the setting in the guide: the answer Keep Running keeps the setting off.
    expect(guide).toContain('the answer **Keep Running** keeps it off');
    // A Stop sends a heartbeat: it is a use of the engine.
    expect(guide).toContain('no devspace was started, stopped or deleted there');
    // Both places in the guide, and the change log.
    expect(guide.split(changed)).toHaveLength(3);
    const paragraph = section(read('CHANGELOG.md'), '0.1.0').split('\n\n').find((text) => text.startsWith('**Background container:**'));
    expect(paragraph).toContain('on each engine from the next start of a devspace or Update All Images Now there; until then, a Monitor that keeps running goes on');
  });

  it('the guide says what the command removes, and removes the Monitor and the helper containers by hand first', () => {
    const text = section(read('docs/guide.md'), 'Uninstall');
    expect(text).toContain('It removes: the container `devspaces-monitor`, the helper containers, the helper images');
    expect(text).not.toContain('names what it removes');
    // Removed first, the Monitor starts no work, and no helper container uses a volume, while the devspaces are deleted.
    const [monitor, helpers] = uninstallCommands();
    const devspaces = text.indexOf('docker rm -f $(docker ps -aq --filter label=nimblescape.devspaces.id)');
    expect(text.indexOf(monitor)).toBeGreaterThan(0);
    expect(text.indexOf(monitor)).toBeLessThan(devspaces);
    expect(text.indexOf(helpers)).toBeLessThan(devspaces);
  });
});

describe('the Marketplace page and the files of the package', () => {
  it('compares Devspaces with no other product: no keyword codespaces, and no text names GitHub Codespaces', () => {
    const manifest = JSON.parse(read('package.json')) as { displayName: string; description: string; keywords: string[] };
    expect(manifest.keywords).not.toContain('codespaces');
    for (const text of [manifest.displayName, manifest.description, ...manifest.keywords]) expect(text).not.toMatch(/codespace/i);
    // The CHANGELOG is the Changelog tab of the Marketplace page, and its sections are the notes of the GitHub releases.
    for (const file of ['README.md', 'CHANGELOG.md', 'SUPPORT.md', 'docs/guide.md', 'docs/security.md', 'docs/architecture.md']) {
      expect(read(file), file).not.toMatch(/codespace/i);
    }
  });

  it('credits the Codicons in ThirdPartyNotices.txt, which the package contains and the README links', () => {
    const notices = read('ThirdPartyNotices.txt');
    for (const words of ['https://github.com/microsoft/vscode-codicons', 'Microsoft Corporation', 'CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/legalcode']) {
      expect(notices).toContain(words);
    }
    for (const file of ['resources/icon.svg', 'resources/icon.png', 'resources/icons/devspace-icons.woff']) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
      expect(notices).toContain(file);
    }
    expect(notices).toContain('"open-in-window"');
    // Every codicon whose shapes the script of the icon font takes.
    const codicons = [...new Set([...read('scripts/build-icon-font.py').matchAll(/`(vm[a-z-]*)`/g)].map((match) => match[1]))].sort();
    expect(codicons).toEqual(['vm', 'vm-connect', 'vm-outline', 'vm-pending', 'vm-running']);
    for (const codicon of codicons) expect(notices).toContain(`"${codicon}"`);
    expect(read('.vscodeignore').split('\n').map((line) => line.trim())).toContain('!ThirdPartyNotices.txt');
    expect(read('README.md')).toContain('(https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/ThirdPartyNotices.txt)');
  });

  it('has SUPPORT.md in the package, linked from the README and the user guide, and the Q&A link opens the issues', () => {
    const manifest = JSON.parse(read('package.json')) as {
      bugs: { url: string };
      qna: unknown;
      contributes: { commands: Array<{ command: string; title: string; category: string }> };
    };
    // vsce turns a qna text other than "marketplace" into the Q&A link of the Marketplace page (CustomerQnALink).
    expect(manifest.qna).toBe(manifest.bugs.url);
    const support = read('SUPPORT.md');
    const showLog = manifest.contributes.commands.find((command) => command.command === Commands.showLog);
    expect(showLog).toMatchObject({ title: 'Show Log', category: 'Devspaces' });
    for (const words of [`(${manifest.bugs.url})`, '**Devspaces: Show Log**', `"${OUTPUT_CHANNEL_NAME}"`, `\`docker logs ${REMOTE_MONITOR_CONTAINER}\``]) {
      expect(support).toContain(words);
    }
    expect(read('.vscodeignore').split('\n').map((line) => line.trim())).toContain('!SUPPORT.md');
    expect(read('README.md')).toContain('(https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/SUPPORT.md)');
    expect(section(read('docs/guide.md'), 'Troubleshooting')).toContain('(../SUPPORT.md)');
  });

  // Devspaces signs in with the GitHub sign-in of VS Code for github.com and asks the GitHub API of github.com.
  it('says in the requirements that only accounts on github.com work', () => {
    expect(GITHUB_PROVIDER_ID).toBe('github');
    expect(GITHUB_GRAPHQL_URL.startsWith('https://api.github.com/')).toBe(true);
    for (const file of ['README.md', 'docs/guide.md']) {
      const requirements = section(read(file), 'Requirements');
      expect(requirements, file).toContain('- A GitHub account on github.com.');
      expect(requirements, file).toContain('Devspaces does not work with GitHub Enterprise Server or GHE.com');
    }
    // The user guide names the settings of VS Code that the note of the view reads (githubEnterpriseConfigured).
    for (const key of ['uris', 'uri']) expect(section(read('docs/guide.md'), 'Requirements')).toContain(`\`${GITHUB_ENTERPRISE_SECTION}.${key}\``);
  });
});
