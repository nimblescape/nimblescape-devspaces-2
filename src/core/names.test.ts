// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { namePair } from './namePairs';
import {
  EXTENSION_LABEL_KEYS,
  LABEL_PREFIX,
  composeProjectName,
  devspaceImageName,
  devspaceImageRepository,
  freeWorkerNumber,
  isDevspaceResourceName,
  resourceName,
  workerNameStart,
} from './names';

const ROOT = path.resolve(__dirname, '..', '..');

/** The TypeScript files of src and test (the Docker tests), with or without the unit tests. */
function codeFiles(tests: boolean): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && (tests || !entry.name.endsWith('.test.ts'))) files.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  if (tests && fs.existsSync(path.join(ROOT, 'test'))) walk(path.join(ROOT, 'test'));
  return files.sort();
}

/** The characters after which a `/` of the code starts a regular expression, not a division. */
const BEFORE_REGEX = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/**
 * The text of the string and template literals of `source` with their quotes (and the `${` and `}` of a template),
 * everything else (the code, the comments, the regular expressions) blanked with spaces, so that each index stays that
 * of `source`. A label key is always the text of a literal; the code names a devspace by identifiers such as
 * `devspace.id`, which are no label keys. TypeScript 7 has no compiler API in its npm package, so this small lexer reads
 * the file; literals that do not close fail the scan (never a label that is silently skipped).
 */
function literalText(source: string, file: string): string {
  const out = source.split('');
  const blank = (i: number) => {
    if (out[i] !== '\n') out[i] = ' ';
  };
  // Template nesting: '`' while in the text of a template, '{' while in the code of a `${…}` or a block within it.
  const stack: Array<'`' | '{'> = [];
  let last = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (stack[stack.length - 1] === '`') {
      if (ch === '\\') i += 2;
      else if (ch === '`') {
        stack.pop();
        i++;
        last = '`';
      } else if (ch === '$' && source[i + 1] === '{') {
        stack.push('{');
        i += 2;
        last = '{';
      } else i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') blank(i++);
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error(`${file}: a block comment does not close`);
      while (i < end + 2) blank(i++);
      continue;
    }
    if (ch === "'" || ch === '"') {
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\n') throw new Error(`${file}: a string literal does not close`);
        i += source[i] === '\\' ? 2 : 1;
      }
      if (i >= source.length) throw new Error(`${file}: a string literal does not close`);
      i++;
      last = ch;
      continue;
    }
    if (ch === '`') {
      stack.push('`');
      i++;
      continue;
    }
    if (ch === '/' && (BEFORE_REGEX.has(last) || /(^|[^\w$])(return|typeof|case|in|of)$/.test(source.slice(Math.max(0, i - 8), i).trimEnd()))) {
      let inClass = false;
      blank(i++);
      while (i < source.length && (source[i] !== '/' || inClass)) {
        if (source[i] === '\n') throw new Error(`${file}: a regular expression does not close`);
        if (source[i] === '\\') blank(i++);
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        blank(i++);
      }
      blank(i++);
      last = ')';
      continue;
    }
    if (ch === '{' && stack.length > 0) stack.push('{');
    if (ch === '}' && stack[stack.length - 1] === '{') {
      stack.pop();
      // The `}` of a `${…}` stays, as its `${`: the text of the template goes on after it.
      if (stack[stack.length - 1] === '`') {
        i++;
        continue;
      }
    }
    if (!/\s/.test(ch)) last = ch;
    blank(i++);
  }
  if (stack.length > 0) throw new Error(`${file}: a template literal does not close`);
  return out.join('');
}

/**
 * The label keys with the prefix `prefix` in the code of `files` (not in comments), with the file. A key that the code
 * builds (`'devspace.' + name`, `devspace.${name}`) is the prefix alone.
 */
function labelKeysInCode(files: readonly string[], prefix: string): Array<{ key: string; file: string }> {
  const pattern = new RegExp(`(?<![\\w.-])${prefix.replace(/[.-]/g, '\\$&')}([a-z0-9._-]*)`, 'gi');
  const found: Array<{ key: string; file: string }> = [];
  for (const file of files) {
    const code = literalText(fs.readFileSync(file, 'utf8'), file);
    for (const match of code.matchAll(pattern)) {
      // The word "devspace" at the end of a sentence of a text ("… the devspace."), not a key.
      if (match[1] === '' && /\s/.test(code[(match.index ?? 0) - 1] ?? '')) continue;
      found.push({ key: `${prefix}${match[1].replace(/\.+$/, '')}`, file: path.relative(ROOT, file) });
    }
  }
  return found;
}

/** The labels with the prefix devspace. (of other tools, or former ones of the extension) that tests allow. */
const FOREIGN_TEST_LABELS = new Set(['devspace.', 'devspace.fingerprint', 'devspace.inputs', 'devspace.environment-id', 'devspace.compose-service']);

/**
 * The IDs of the extension in VS Code (commands, settings, views, context keys) start with `devspaces.`. They are no
 * labels: every `devspaces.…` text of package.json, and the few IDs that the code gives VS Code without declaring them
 * there (the status bar item, the webview type, the focus command of the view, the context keys of the Docker setup, a
 * command name that must not exist).
 */
const VSCODE_IDS: ReadonlySet<string> = new Set([
  ...(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').match(/devspaces\.[A-Za-z0-9._-]*[A-Za-z0-9]/g) ?? []),
  'devspaces.status',
  'devspaces.repositoryGroupsEditor',
  'devspaces.repositories.focus',
  'devspaces.dockerInstalled',
  'devspaces.dockerMissing',
  'devspaces.dockerReady',
  // A command name that dockerSetupSidebar.test.ts checks is absent.
  'devspaces.installDocker',
]);

describe('EXTENSION_LABEL_KEYS', () => {
  it('holds every label with LABEL_PREFIX of the code of src, and each of its keys is used there', () => {
    const found = labelKeysInCode(codeFiles(false), LABEL_PREFIX);
    // A new label of the extension belongs in the set (the policy refuses it by its prefix anyway).
    expect(found.filter(({ key, file }) => !EXTENSION_LABEL_KEYS.has(key) && !(key === LABEL_PREFIX && file === 'src/core/names.ts'))).toEqual([]);
    expect([...EXTENSION_LABEL_KEYS].filter((key) => !found.some((entry) => entry.key === key))).toEqual([]);
  });

  it('holds the keys in lower case, each with LABEL_PREFIX', () => {
    expect(LABEL_PREFIX).toBe('nimblescape.devspaces.');
    for (const key of EXTENSION_LABEL_KEYS) expect(key).toMatch(/^nimblescape\.devspaces\.[a-z0-9][a-z0-9-]*$/);
  });

  it('holds exactly the labels of the extension', () => {
    expect([...EXTENSION_LABEL_KEYS].map((key) => key.slice(LABEL_PREFIX.length)).sort()).toEqual([
      // The build label of BootstrapDocker.buildImage.
      'build-id',
      // The build record on the devspace image (EngineDocker.labelImage).
      'build-record',
      // The label of the containers that a cancel of an operation removes.
      'channel-step',
      'compose-service',
      'config-path',
      'container-config',
      'container-version',
      // The source of a default-image devspace, on its workspace volume (devspaceOfVolume).
      'default-image',
      'host-access',
      // The ID label of a devspace.
      'id',
      // The label of the Monitor container: the hash of its script, image, and mode.
      'monitor',
      // The nonce label of each create of the remote Monitor, by which a failed create removes only its own
      // container.
      'monitor-create',
      // The owner of a permanent Monitor: the ID of the computer that created it.
      'monitor-owner',
      'owner-id',
      // The prepare key and helper image of the prepared devspace image.
      'prepared',
      'repository',
      'service-data',
      'volume',
      // The label of the helper image.
      'worker',
      // The label of the container of a helper channel.
      'worker-channel',
      // The label of every container of the helper image but the Monitor.
      'worker-run',
    ]);
  });

  it('leaves no label with the prefix devspace. in the code, only in the tests of labels of other tools', () => {
    // Another tool named devspace labels its images devspace.…; the extension uses none of these.
    const found = labelKeysInCode(codeFiles(true), 'devspace.');
    expect(found.filter(({ file }) => !file.endsWith('.test.ts'))).toEqual([]);
    expect(found.filter(({ key }) => !FOREIGN_TEST_LABELS.has(key))).toEqual([]);
    expect(found.some(({ key }) => key === 'devspace.fingerprint')).toBe(true);
  });

  it('leaves no label with the prefix devspaces. in the code: each key with it is an ID of the extension in VS Code', () => {
    // A label of the extension starts with LABEL_PREFIX; a key without `nimblescape.` would not be refused by the policy.
    // The tests find the IDs by the prefix alone.
    const found = labelKeysInCode(codeFiles(true), 'devspaces.').filter(({ key }) => !VSCODE_IDS.has(key));
    expect(found.filter(({ key, file }) => !(key === 'devspaces.' && file.endsWith('.test.ts')))).toEqual([]);
    expect(VSCODE_IDS.has('devspaces.start')).toBe(true);
  });
});

// One name for every resource of a devspace, devspaces-<owner>-<repo>-<adjective>-<scientist>.
describe('resourceName', () => {
  const ID = '11111111-2222-4333-8444-555555555555';

  it('is devspaces-<owner>-<repository>-<pair of the devspace ID>', () => {
    expect(resourceName('acme/api', ID)).toBe(`devspaces-acme-api-${namePair(ID)}`);
    expect(resourceName('acme/api', ID)).toMatch(/^devspaces-acme-api-[a-z]+-[a-z]+$/);
  });

  it('is the same for the same ID and differs by the ID and the repository', () => {
    expect(resourceName('acme/api', ID)).toBe(resourceName('acme/api', ID));
    expect(resourceName('acme/web', ID)).not.toBe(resourceName('acme/api', ID));
    expect(resourceName('acme/api', '22222222-2222-4222-8222-222222222222')).toBe('devspaces-acme-api-noble-berners');
  });

  it('carries the segment of the source of the devspace before the pair (the names of a devspace of version 0.6.0)', () => {
    expect(resourceName('acme/api', ID, 'config')).toBe(`devspaces-acme-api-config-${namePair(ID)}`);
    expect(resourceName('acme/api', ID, 'default')).toBe(`devspaces-acme-api-default-${namePair(ID)}`);
    expect(resourceName('acme/api', ID, 'python')).toBe(`devspaces-acme-api-python-${namePair(ID)}`);
    expect(isDevspaceResourceName(resourceName('acme/api', ID, 'python'))).toBe(true);
    // The segment is kept whole; a long owner and repository are shortened for it.
    const long = resourceName(`${'a'.repeat(40)}/${'b'.repeat(40)}`, ID, 'x'.repeat(24));
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long.endsWith(`-${'x'.repeat(24)}-${namePair(ID)}`)).toBe(true);
    expect(long.startsWith('devspaces-aaaa')).toBe(true);
  });

  it('is in lower case, each run of other characters than [a-z0-9] one -', () => {
    expect(resourceName('Acme/My.Repo_Name', ID)).toBe(`devspaces-acme-my-repo-name-${namePair(ID)}`);
    expect(resourceName('o/name-with--dashes---', ID)).toBe(`devspaces-o-name-with-dashes-${namePair(ID)}`);
    expect(resourceName('-x/._y', ID)).toBe(`devspaces-x-y-${namePair(ID)}`);
  });

  it('has at most 63 characters: a long owner and repository are shortened, the pair is kept', () => {
    const name = resourceName(`${'a'.repeat(40)}/${'b'.repeat(40)}`, ID);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith(`devspaces-${'a'.repeat(20)}`)).toBe(true);
    expect(name.endsWith(`-${namePair(ID)}`)).toBe(true);
    expect(isDevspaceResourceName(name)).toBe(true);
    // A cut that ends in a separator drops it.
    const dashed = resourceName(`${'a'.repeat(30)}/${'-b'.repeat(30)}`, ID);
    expect(dashed.length).toBeLessThanOrEqual(63);
    expect(dashed).not.toMatch(/--/);
    expect(dashed.endsWith(`-${namePair(ID)}`)).toBe(true);
    expect(isDevspaceResourceName(dashed)).toBe(true);
  });

  it('names an owner and repository of only separators `x`', () => {
    expect(resourceName('-/_', ID)).toBe(`devspaces-x-${namePair(ID)}`);
    expect(isDevspaceResourceName(resourceName('-/_', ID))).toBe(true);
  });

  it('refuses a repository without owner or name', () => {
    expect(() => resourceName('api', ID)).toThrow();
    expect(() => resourceName('acme/', ID)).toThrow();
  });
});

describe('isDevspaceResourceName', () => {
  const ID = '11111111-2222-4333-8444-555555555555';

  it('refuses `_` and `.` in the name (resourceName never writes them)', () => {
    const name = resourceName('acme/api', ID);
    expect(isDevspaceResourceName(name.replace('devspaces-acme-', 'devspaces-acme_'))).toBe(false);
    expect(isDevspaceResourceName(name.replace('devspaces-acme-', 'devspaces-acme.'))).toBe(false);
  });

  it.each(['acme/api', 'Acme/My.Repo_Name', 'a/b', 'devspace/x', `${'a'.repeat(40)}/${'b'.repeat(40)}`])('takes the name of a devspace of %s', (repository) => {
    expect(isDevspaceResourceName(resourceName(repository, ID))).toBe(true);
  });

  it.each([
    'devspaces-tools-node_modules',
    'devspaces-tools',
    'devspaces-cache',
    'devspaces-worker-cache',
    'devspaces-acme-api',
    'devspaces-acme-api-3f2a9c1e',
    'devspaces-acme-api-tidy',
    'devspaces-acme-api-tidy-nobody',
    'devspaces-acme-api-nobody-berners',
    'devspaces-acme-api-tidy-berners_data',
    'acme-api-tidy-berners',
    'x-devspace-acme-api-tidy-berners',
    '',
  ])('does not take %j for one', (name) => {
    expect(isDevspaceResourceName(name)).toBe(false);
  });

  it('ignores the case', () => {
    expect(isDevspaceResourceName('DEVSPACES-ACME-API-TIDY-BERNERS')).toBe(true);
    expect(isDevspaceResourceName(resourceName('acme/api', ID).toUpperCase())).toBe(true);
  });
});

describe('workerNameStart', () => {
  /** The names that Docker takes for a container. */
  const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
  /** The name of a worker: workerNameStart and the number. */
  const workerName = (windowName: string, number: number, devspaceName?: string) => `${workerNameStart(windowName, devspaceName)}${number}`;

  it('is devspaces-<window>-worker for a window of no devspace', () => {
    expect(workerName('api', 1)).toBe('devspaces-api-worker1');
    expect(workerName('my-project', 1)).toBe('devspaces-my-project-worker1');
  });

  it('is in lower case, letters without accents, each run of other characters than [a-z0-9] one -', () => {
    expect(workerName('My Project (2)', 1)).toBe('devspaces-my-project-2-worker1');
    expect(workerName('Übung_Café.Web', 1)).toBe('devspaces-ubung-cafe-web-worker1');
    expect(workerName('--a..b--', 1)).toBe('devspaces-a-b-worker1');
    // Letters without an accent to remove get plain letters.
    expect(workerName('Straße Øl Łódź', 1)).toBe('devspaces-strasse-ol-lodz-worker1');
    expect(workerName('Æ Œ Đ Ð', 1)).toBe('devspaces-ae-oe-d-d-worker1');
    expect(workerName('Işık Þór Ħ Ŧ Ŋ', 1)).toBe('devspaces-isik-thor-h-t-n-worker1');
  });

  it('names a window without a name, or with a name of no [a-z0-9], window', () => {
    for (const name of ['', '---', '工作区', ' ']) expect(workerName(name, 1)).toBe('devspaces-window-worker1');
  });

  it('is short: a longer window name is cut to 24 characters at the end of a word, so the name has at most 43 up to 99', () => {
    expect(workerName('nimblescape-devspaces', 1)).toBe('devspaces-nimblescape-devspaces-worker1');
    expect(workerName('nimblescape-markdown-comment-links', 1)).toBe('devspaces-nimblescape-markdown-worker1');
    expect(workerName('devcontainer-classroom-web-advanced', 1)).toBe('devspaces-devcontainer-classroom-worker1');
    // A word that ends exactly at the cut is kept; the separator after it is dropped.
    expect(workerName(`${'a'.repeat(11)}-${'b'.repeat(12)}-c`, 1)).toBe(`devspaces-${'a'.repeat(11)}-${'b'.repeat(12)}-worker1`);
    // A first word longer than 24 characters is cut within it.
    expect(workerName('x'.repeat(80), 1)).toBe(`devspaces-${'x'.repeat(24)}-worker1`);
    expect(workerName(`${'x'.repeat(30)}-y`, 99)).toHaveLength(43);
    // So is a long word after words of less than half of the room, so that they are not all that is left.
    expect(workerName('a-verylongrepositorynames-service', 1)).toBe('devspaces-a-verylongrepositoryname-worker1');
    expect(workerName(`${'a'.repeat(11)}-${'b'.repeat(20)}`, 1)).toBe(`devspaces-${'a'.repeat(11)}-${'b'.repeat(12)}-worker1`);
    expect(workerName(`${'a'.repeat(12)}-${'b'.repeat(20)}`, 1)).toBe(`devspaces-${'a'.repeat(12)}-worker1`);
    // A cut within a word never ends in a separator.
    expect(workerName(`a-${'b'.repeat(21)}-cc`, 1)).toBe(`devspaces-a-${'b'.repeat(21)}-worker1`);
  });

  it('ends in its number after worker, so it is never a name of a devspace or of Docker Compose', () => {
    expect(workerName('api', 12)).toBe('devspaces-api-worker12');
    // A window name that ends like a devspace name (`<adjective>-<scientist>`).
    const window = 'api-tidy-berners';
    expect(isDevspaceResourceName(`devspaces-${window}`)).toBe(true);
    for (const number of [1, 2, 10, 99]) {
      const name = workerName(window, number);
      expect(name).toBe(`devspaces-api-tidy-berners-worker${number}`);
      expect(name).toMatch(DOCKER_NAME);
      expect(isDevspaceResourceName(name)).toBe(false);
      // Docker Compose names its containers `<project>-<service>-<number>`.
      expect(name).not.toMatch(/-[0-9]+$/);
    }
  });

  it('is <devspace>-worker for a window of a devspace, whatever the window name, never a name of Docker Compose', () => {
    const ID = '11111111-2222-4333-8444-555555555555';
    const devspace = resourceName('majikmate/module-html-css-2', ID);
    expect(workerName('module-html-css-2', 1, devspace)).toBe(`${devspace}-worker1`);
    expect(workerName('', 2, devspace.toUpperCase())).toBe(`${devspace}-worker2`);
    // The longest devspace name.
    const longest = resourceName(`${'o'.repeat(40)}/${'r'.repeat(40)}`, ID);
    expect(longest).toHaveLength(63);
    for (const name of [workerName('api', 1, devspace), workerName('api', 99, longest)]) {
      expect(name).toMatch(DOCKER_NAME);
      expect(isDevspaceResourceName(name)).toBe(false);
      // Docker Compose names its containers `<project>-<service>-<number>`.
      expect(name).not.toMatch(/-[0-9]+$/);
    }
  });

  it('takes the window name for a devspace name that has not the shape of one', () => {
    for (const devspace of [undefined, '', 'devspaces-acme-api', 'acme-api-tidy-berners', 'devspaces-acme_api-tidy-berners']) {
      expect(workerName('api', 1, devspace)).toBe('devspaces-api-worker1');
    }
  });
});

describe('freeWorkerNumber', () => {
  it('is the lowest number from 1 that no container name and no tried start has', () => {
    expect(freeWorkerNumber(workerNameStart('api'), [], new Set())).toBe(1);
    expect(freeWorkerNumber(workerNameStart('api'), ['devspaces-api-worker1', 'devspaces-api-worker3'], new Set())).toBe(2);
    expect(freeWorkerNumber(workerNameStart('api'), ['devspaces-api-worker1', 'devspaces-api-worker3'], new Set([2]))).toBe(4);
    expect(freeWorkerNumber(workerNameStart('api'), [], new Set([1]))).toBe(2);
  });

  it('counts only the names of the same window part, compared as workerNameStart writes them', () => {
    // Other windows, and a window name that differs only in what the window part drops.
    expect(freeWorkerNumber(workerNameStart('API'), ['devspaces-web-worker1', 'devspaces-api-2-worker1', 'devspaces-api-worker', ''], new Set())).toBe(1);
    expect(freeWorkerNumber(workerNameStart('My API'), ['devspaces-my-api-worker1'], new Set())).toBe(2);
    expect(freeWorkerNumber(workerNameStart(''), ['devspaces-window-worker1', 'devspaces-window-worker2'], new Set())).toBe(3);
  });

  it('counts only exact names, not the longer names that the filter of Docker also lists (a part of a name)', () => {
    expect(freeWorkerNumber(workerNameStart('api'), ['devspaces-api-worker12', 'devspaces-api-worker1-x', 'x-devspaces-api-worker1'], new Set())).toBe(1);
  });
});

describe('the names derived from resourceName', () => {
  const ID = '11111111-2222-4333-8444-555555555555';

  it('the Compose project and the repository of the devspace image are resourceName', () => {
    expect(composeProjectName('acme/api', ID)).toBe(resourceName('acme/api', ID));
    expect(devspaceImageRepository('acme/api', ID)).toBe(resourceName('acme/api', ID));
    expect(composeProjectName('Acme/My.Repo', ID)).toBe(resourceName('Acme/My.Repo', ID));
  });

  it('the devspace image is <resourceName>:<build number>', () => {
    expect(devspaceImageName('acme/api', ID, 3)).toBe(`${resourceName('acme/api', ID)}:3`);
    expect(devspaceImageName('acme/api', ID, 1)).toBe('devspaces-acme-api-tidy-berners:1');
  });
});
