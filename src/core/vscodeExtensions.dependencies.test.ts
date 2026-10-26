// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The dependencies of an extension (`extensionDependencies` and `extensionPack`), which the VS Code server installs
// with it: their IDs in an answer of the Marketplace, the version that keeps them, their file in the monitor's volume,
// and the IDs that the server installs with the entries of a list, transitively.
import { describe, expect, it } from 'vitest';
import {
  MAX_LISTED_EXTENSIONS,
  chooseExtensionVersion,
  dependencyIds,
  dependencyIdsOf,
  formatExtensionDependencies,
  parseExtensionDependencies,
  parseMarketplaceAnswer,
} from './vscodeExtensions';

describe('the dependencies of an extension', () => {
  it('reads the IDs of both properties: lower case, each once, no version, no built-in extension of VS Code, bounded', () => {
    expect(dependencyIdsOf(['Bierner.Markdown-Emoji, bierner.markdown-checkbox,,vscode.git', 'bierner.markdown-emoji,pin.ned@1.0.0,no id,ms-vscode.js-debug'])).toEqual([
      'bierner.markdown-emoji',
      'bierner.markdown-checkbox',
      'ms-vscode.js-debug',
    ]);
    expect(dependencyIdsOf([undefined, ''])).toEqual([]);
    const many = Array.from({ length: MAX_LISTED_EXTENSIONS + 5 }, (_, index) => `p.e${index}`).join(',');
    expect(dependencyIdsOf([many])).toHaveLength(MAX_LISTED_EXTENSIONS);
  });

  it('an answer of the Marketplace gives each version its dependencies; the chosen version keeps those of its own', () => {
    const vsix = (number: string) => [{ assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source: `https://cdn.gallerycdn.vsassets.io/${number}.vsix` }];
    const answer = parseMarketplaceAnswer(
      JSON.stringify({
        results: [
          {
            extensions: [
              {
                publisher: { publisherName: 'bierner' },
                extensionName: 'github-markdown-preview',
                versions: [
                  {
                    version: '0.4.0',
                    properties: [
                      { key: 'Microsoft.VisualStudio.Code.Engine', value: '^1.90.0' },
                      { key: 'Microsoft.VisualStudio.Code.ExtensionDependencies', value: 'bierner.markdown-it' },
                      { key: 'Microsoft.VisualStudio.Code.ExtensionPack', value: 'bierner.markdown-emoji,bierner.markdown-checkbox' },
                    ],
                    files: vsix('0.4.0'),
                  },
                  { version: '0.3.0', properties: [{ key: 'Microsoft.VisualStudio.Code.Engine', value: '^1.90.0' }], files: vsix('0.3.0') },
                ],
              },
            ],
          },
        ],
      }),
    );
    const versions = answer?.get('bierner.github-markdown-preview') ?? [];
    expect(versions.map((entry) => entry.dependencies)).toEqual([['bierner.markdown-it', 'bierner.markdown-emoji', 'bierner.markdown-checkbox'], undefined]);
    expect(chooseExtensionVersion({ id: 'bierner.github-markdown-preview' }, versions, '1.105.0', 'linux-x64')?.dependencies).toEqual([
      'bierner.markdown-it',
      'bierner.markdown-emoji',
      'bierner.markdown-checkbox',
    ]);
    const older = chooseExtensionVersion({ id: 'bierner.github-markdown-preview', version: '0.3.0' }, versions, '1.105.0', 'linux-x64');
    expect(older?.version).toBe('0.3.0');
    expect(older?.dependencies).toBeUndefined();
  });

  it('the file of the dependencies is read strictly and written sorted', () => {
    const text = formatExtensionDependencies(new Map([['z.z', ['a.a']], ['pin.ned@1.0.0', ['b.b', 'c.c']]]));
    expect(text).toBe('{"pin.ned@1.0.0":["b.b","c.c"],"z.z":["a.a"]}\n');
    expect([...parseExtensionDependencies(text)]).toEqual([
      ['pin.ned@1.0.0', ['b.b', 'c.c']],
      ['z.z', ['a.a']],
    ]);
    // Left out: an entry that is not canonical, an empty list, an ID that is not canonical or that has a version, an ID
    // twice, a list that is no list of texts.
    const loose = JSON.stringify({ 'A.B': ['c.c'], 'e.e': [], 'f.f': ['C.C'], 'g.g': ['c.c@1.0.0'], 'h.h': ['c.c', 'c.c'], 'i.i': 'c.c', 'j.j': [1], 'k.k': ['c.c'] });
    expect([...parseExtensionDependencies(loose)]).toEqual([['k.k', ['c.c']]]);
    expect(parseExtensionDependencies('not json').size).toBe(0);
    expect(parseExtensionDependencies('[]').size).toBe(0);
  });

  it('the IDs that the server installs with a list: transitively, without the IDs of the list, each once, sorted', () => {
    const dependencies = new Map([
      ['p.pack', ['d.one', 'd.two', 'l.listed']],
      ['d.one', ['d.three', 'p.pack']],
      ['pin.ned@1.0.0', ['d.four']],
      // The dependencies of another version of the pinned entry, and of an entry that no list names: not counted.
      ['pin.ned', ['d.other']],
      ['u.unlisted', ['d.five']],
    ]);
    expect(dependencyIds([{ id: 'p.pack' }, { id: 'l.listed' }, { id: 'pin.ned', version: '1.0.0' }], dependencies)).toEqual(['d.four', 'd.one', 'd.three', 'd.two']);
    expect(dependencyIds([], dependencies)).toEqual([]);
  });
});
