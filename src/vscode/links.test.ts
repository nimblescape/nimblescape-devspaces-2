// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { OPEN_LINK_PATH, REPOSITORY_PARAMETER, parseLink } from './links';

describe('parseLink', () => {
  it('reads the repository of the link /open', () => {
    expect(parseLink('/open', 'repository=majikmate/devcontainer-classroom-web')).toEqual({ kind: 'open', repository: 'majikmate/devcontainer-classroom-web' });
    expect(parseLink(OPEN_LINK_PATH, `${REPOSITORY_PARAMETER}=Acme/My.Repo_1`)).toEqual({ kind: 'open', repository: 'Acme/My.Repo_1' });
    // An account of an Enterprise Managed User.
    expect(parseLink('/open', 'repository=alice_acme/api')).toEqual({ kind: 'open', repository: 'alice_acme/api' });
  });

  it('ignores other parameters, for later versions of the link', () => {
    expect(parseLink('/open', 'source=default&repository=acme/api&x=1')).toEqual({ kind: 'open', repository: 'acme/api' });
  });

  it('opens nothing for another path', () => {
    for (const path of ['', '/', '/Open', '/open/', '/start', '/open/acme/api']) {
      expect(parseLink(path, 'repository=acme/api')).toEqual({ kind: 'invalid', reason: 'its path is not /open' });
    }
  });

  it('opens nothing without exactly one parameter repository', () => {
    for (const query of ['', 'repo=acme/api', 'repositoryx=acme/api', 'repository=acme/api&repository=acme/web']) {
      expect(parseLink('/open', query)).toEqual({ kind: 'invalid', reason: 'it needs one parameter repository' });
    }
  });

  it('opens nothing for a text that is no GitHub repository', () => {
    const invalid = [
      '',
      // Encoded twice by the website: vscode.Uri decodes once, and the value is not decoded again.
      'acme%2Fapi',
      'acme/api%20',
      'acme',
      'acme/',
      '/api',
      'acme/api/tree/main',
      '-acme/api',
      '_acme/api',
      'ac me/api',
      'acme/a pi',
      'acme/a+pi',
      'acme/api=x',
      'acme/.',
      'acme/..',
      'acme/api.git',
      'acme/api.GIT',
      'acme/api\n',
      `${'a'.repeat(40)}/api`,
      `acme/${'a'.repeat(101)}`,
      'https://github.com/acme/api',
      'acme/api;rm',
      'acme/äpi',
    ];
    for (const repository of invalid) {
      expect(parseLink('/open', `repository=${repository}`)).toEqual({
        kind: 'invalid',
        reason: 'its parameter repository is not a GitHub repository owner/name',
      });
    }
    // The longest names that GitHub allows.
    const longest = `${'a'.repeat(39)}/${'b'.repeat(100)}`;
    expect(parseLink('/open', `repository=${longest}`)).toEqual({ kind: 'open', repository: longest });
  });
});
