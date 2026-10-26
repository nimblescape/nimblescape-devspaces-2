// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Mutation testing: downloadToFile with `allowedUrl` refuses a URL that does not parse before any request (the check of
// the allowed hosts fails closed).
import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';
import { downloadToFile } from './vscodeServerStore';

describe('the allowed hosts of a download, an unparsable URL', () => {
  it('is refused before any request', async () => {
    const urls: string[] = [];
    const transport = {
      stream: async (url: string) => {
        urls.push(url);
        return { status: 200, headers: {}, body: Readable.from([Buffer.from('x')]) };
      },
    };
    await expect(downloadToFile(transport, 'not a url', '/nonexistent/never-written', 10, new AbortController().signal, () => true)).rejects.toThrow('not on an allowed host');
    expect(urls).toEqual([]);
  });
});
