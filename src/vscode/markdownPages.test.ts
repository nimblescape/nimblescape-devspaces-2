// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// The release packages the extension with `vsce package --no-rewrite-relative-links`. That option also turns off the
// checks of vsce for the images of README.md and CHANGELOG.md (an HTTPS source, no SVG), and a relative link stays
// relative, so it is broken on the Marketplace page. These tests make those checks. They also refuse a raw tag such
// as <owner> outside code: the Marketplace and GitHub take it as HTML and show nothing in its place.
const ROOT = path.join(__dirname, '..', '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** The Markdown with the code blocks and code spans blanked out; the line numbers stay. */
function withoutCode(markdown: string): string {
  let fence: string | undefined;
  const lines = markdown.split('\n').map((line) => {
    // A fence of backticks has no backtick after them; a fence of tildes may have anything.
    const marker = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/.exec(line)?.[1];
    if (fence === undefined) {
      fence = marker;
      return marker ? '' : line;
    }
    if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = undefined;
    return '';
  });
  // A code span starts at a run of backticks without a backslash before it (an even number of backslashes escape each
  // other), and ends at the next run of as many backticks in the same paragraph.
  return lines
    .join('\n')
    .split(/(\n[ \t]*\n)/)
    .map((part) => part.replace(/(?<=(?:^|[^\\`])(?:\\\\)*)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, (span) => span.replace(/[^\n]/g, '')))
    .join('');
}

/** A link reference definition, `[label]: target`, with its label and its target. */
const DEFINITION = /^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]*)/;

/** A label as CommonMark matches it: without case, and with each run of whitespace as one space. */
const normalLabel = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();

/** The problem of the source of an image, if any: vsce takes only an image from an HTTPS source, and no SVG. */
function imageProblem(source: string): string | undefined {
  if (!/^https:\/\//i.test(source)) return `image not from an HTTPS source ${source}`;
  if (!URL.canParse(source)) return `image with an invalid URL ${source}`;
  if (/\.svg$/i.test(new URL(source).pathname)) return `SVG image ${source}`;
  return undefined;
}

/** The problems of a Markdown page for the Marketplace, as `line: problem`. */
function problems(markdown: string, checks: { links: boolean } = { links: true }): string[] {
  const found: string[] = [];
  const lines = withoutCode(markdown).split('\n');
  // The targets of the definitions by their label; the first definition of a label counts.
  const definitions = new Map<string, string>();
  for (const line of lines) {
    const definition = DEFINITION.exec(line);
    if (definition && !definitions.has(normalLabel(definition[1]))) definitions.set(normalLabel(definition[1]), definition[2]);
  }
  lines.forEach((line, index) => {
    const at = `${index + 1}: `;
    for (const tag of line.matchAll(/(?<!\\)<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>])[^>]*>?/g)) found.push(`${at}raw tag ${tag[0]}`);
    if (!checks.links) return;
    const targets = [...line.matchAll(/\]\(\s*<?([^\s>)]*)/g), ...line.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?([^\s>]*)/g)];
    for (const [, target] of targets) {
      if (!/^(\w+:\/\/|mailto:|#)/i.test(target)) found.push(`${at}relative link ${target}`);
    }
    const check = (source: string) => {
      const problem = imageProblem(source);
      if (problem !== undefined) found.push(`${at}${problem}`);
    };
    for (const [, source] of line.matchAll(/!\[[^\]]*\]\(\s*<?([^\s>)]*)/g)) check(source);
    // `![text][label]`, `![label][]` and `![label]`, each with the target of the definition of its label.
    for (const [, text, reference] of line.matchAll(/!\[([^\]]*)\](?:\[([^\]]*)\]|(?![[(]))/g)) {
      const label = reference || text;
      const source = definitions.get(normalLabel(label));
      if (source === undefined) found.push(`${at}image reference without a definition ${label}`);
      else check(source);
    }
  });
  return found;
}

describe('the checks of a Markdown page', () => {
  it('finds relative links, images that are not HTTPS or are SVG, and raw tags', () => {
    const page = [
      'See [the guide](docs/guide.md) and [the logo](./resources/icon.png).',
      '![Logo](http://example.com/logo.png) ![Badge](https://example.com/badge.svg?style=flat)',
      'The name devspaces-<owner>-<repo> and <img src="x.png"> and </b>.',
      '[guide]: docs/guide.md',
      // An image by reference: full, collapsed and shortcut. A label matches without case, and with each run of
      // whitespace as one space.
      '![Plain][Plain  HTTP] ![Logo][] ![logo]',
      '![Lost][nowhere]',
      '[plain http]: http://example.com/plain.png',
      '[LOGO]: https://example.com/logo.svg',
    ].join('\n');
    expect(problems(page)).toEqual([
      '1: relative link docs/guide.md',
      '1: relative link ./resources/icon.png',
      '2: image not from an HTTPS source http://example.com/logo.png',
      '2: SVG image https://example.com/badge.svg?style=flat',
      '3: raw tag <owner>',
      '3: raw tag <repo>',
      '3: raw tag <img src="x.png">',
      '3: raw tag </b>',
      '4: relative link docs/guide.md',
      '5: image not from an HTTPS source http://example.com/plain.png',
      '5: SVG image https://example.com/logo.svg',
      '5: SVG image https://example.com/logo.svg',
      // vsce finds no image there.
      '6: image reference without a definition nowhere',
    ]);
  });

  // As in CommonMark: a fenced code block ends only at its closing fence, also after a blank line; backticks with a
  // backtick after them open no fence; a backtick after a backslash starts no code span.
  it('finds a raw tag after fenced code with a blank line, after backticks that open no fence, and after an escaped backtick', () => {
    expect(problems('```\n<a>\n\n<b>\n```\nafter <c>')).toEqual(['6: raw tag <c>']);
    expect(problems('```x``` and <owner>\n<next>')).toEqual(['1: raw tag <owner>', '2: raw tag <next>']);
    expect(problems('An escaped \\` and <owner> and `code`.')).toEqual(['1: raw tag <owner>']);
  });

  it('names an image whose HTTPS URL is not valid', () => {
    expect(problems('![Broken](https://)')).toEqual(['1: image with an invalid URL https://']);
  });

  it('accepts absolute links, anchors, autolinks, code and text that is no tag', () => {
    const page = [
      'See [Security](https://github.com/acme/repo/blob/main/docs/security.md#top), [Usage](#usage), <https://example.com>,',
      '[mail](mailto:team@example.com), ![Shot](https://example.com/shot.png) and the name `devspaces-<owner>-<repo>`.',
      '![Shot][shot], ![Shot][] and ![shot] by reference.',
      '[Shot]: https://example.com/shot.png',
      'A worker is devspace-worker-<12 characters>; 1 < 2 and \\<owner> stay text; `` a ` <b> `` is code.',
      'After an escaped backslash, \\\\`<b>` is code.',
      '```',
      'docker run --name <worker name> [x](relative.md)',
      '```',
      'Back in text.',
    ].join('\n');
    expect(problems(page)).toEqual([]);
  });

  it('can check only the raw tags, for a page on GitHub whose relative links work', () => {
    expect(problems('[Guide](guide.md) of <host>', { links: false })).toEqual(['1: raw tag <host>']);
  });
});

describe('the Markdown pages', () => {
  it.each(['README.md', 'CHANGELOG.md'])('%s has no relative link, no image without HTTPS, no SVG image and no raw tag', (file) => {
    expect(problems(read(file))).toEqual([]);
  });

  const docs = fs.readdirSync(path.join(ROOT, 'docs')).filter((file) => file.endsWith('.md'));

  it('finds the pages of docs/', () => {
    expect(docs).toEqual(expect.arrayContaining(['architecture.md', 'guide.md', 'security.md']));
  });

  // The pages that only GitHub shows, where a relative link works: the pages of docs/ and CONTRIBUTING.md.
  const githubPages = [...docs.map((file) => `docs/${file}`), 'CONTRIBUTING.md'];

  it.each(githubPages)('%s has no raw tag, so that GitHub shows each placeholder such as `<host>`', (file) => {
    expect(problems(read(file), { links: false })).toEqual([]);
  });
});
