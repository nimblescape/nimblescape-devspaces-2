// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { COURSE_LINK_PATH, OPEN_LINK_PATH, REPOSITORY_PARAMETER, courseRepository, parseLink } from './links';

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
    for (const path of ['', '/', '/Open', '/open/', '/start', '/open/acme/api', '/Course', '/course/', '/courses']) {
      expect(parseLink(path, 'repository=acme/api')).toEqual({ kind: 'invalid', reason: 'its path is not /open or /course' });
    }
  });

  it('opens nothing without exactly one parameter repository', () => {
    for (const path of ['/open', '/course']) {
      for (const query of ['', 'repo=acme/api', 'repositoryx=acme/api', 'repository=acme/api&repository=acme/web']) {
        expect(parseLink(path, query)).toEqual({ kind: 'invalid', reason: 'it needs one parameter repository' });
      }
    }
  });

  it('takes no placeholder in the link /open', () => {
    expect(parseLink('/open', 'repository=acme/api-<username>')).toEqual({ kind: 'invalid', reason: 'its parameter repository is not a GitHub repository owner/name' });
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

  // A course of GitHub Classroom: the assignment my-school/2026-1a-module-ts-2, and the repository of the student with
  // the login octocat, my-school/2026-1a-module-ts-2-octocat.
  it('reads the course link with the placeholder <username>, and adds it at the end of a name without it', () => {
    const template = 'my-school/2026-1a-module-ts-2-<username>';
    expect(parseLink(COURSE_LINK_PATH, `${REPOSITORY_PARAMETER}=${template}`)).toEqual({ kind: 'course', template });
    expect(parseLink('/course', 'repository=my-school/2026-1a-module-ts-2')).toEqual({ kind: 'course', template });
    // The placeholder can stand anywhere in the name, also more than once.
    expect(parseLink('/course', 'repository=acme/<username>-homework')).toEqual({ kind: 'course', template: 'acme/<username>-homework' });
    expect(parseLink('/course', 'source=x&repository=acme/<username>.<username>')).toEqual({ kind: 'course', template: 'acme/<username>.<username>' });
    // A course repository whose name is not valid alone becomes one with the login: `acme/.` gives `acme/.-<username>`.
    expect(parseLink('/course', 'repository=acme/.')).toEqual({ kind: 'course', template: 'acme/.-<username>' });
  });

  it('opens nothing for a course link that is no GitHub repository, also with the login', () => {
    const invalid = [
      '',
      'acme',
      'acme%2Fapi',
      '/api',
      'acme/api/tree/main',
      '-acme/api',
      'ac me/api',
      'acme/a pi',
      'acme/api;rm',
      'acme/äpi',
      `${'a'.repeat(40)}/api`,
      // With `-<username>`, the name is longer than 100 characters, also with a login of one character.
      `acme/${'a'.repeat(99)}`,
      'https://github.com/acme/api',
      // The placeholder belongs in the name, not in the owner, which is the organization of the course.
      '<username>/api',
      '<username>',
      'acme-<username>',
      // Another placeholder, or one that the website encoded twice.
      'acme/<USERNAME>',
      'acme/{username}',
      'acme/api-%3Cusername%3E',
      'acme/<username>/x',
      'acme/<username>.git',
    ];
    for (const value of invalid) {
      expect(parseLink('/course', `repository=${value}`), value).toEqual({ kind: 'invalid', reason: 'its parameter repository is not a GitHub repository owner/name-<username>' });
    }
  });
});

describe('courseRepository', () => {
  it('puts the login of the account in place of every placeholder', () => {
    expect(courseRepository('my-school/2026-1a-module-ts-2-<username>', 'octocat')).toBe('my-school/2026-1a-module-ts-2-octocat');
    expect(courseRepository('acme/<username>.<username>', 'octo')).toBe('acme/octo.octo');
    // An account of an Enterprise Managed User.
    expect(courseRepository('acme/api-<username>', 'alice_acme')).toBe('acme/api-alice_acme');
  });

  it('gives no repository when the name with the login is no GitHub repository name', () => {
    // 100 characters are allowed: 94 and `-octo` are 99, 96 and `-octo` are 101.
    expect(courseRepository(`acme/${'b'.repeat(94)}-<username>`, 'octo')).toBe(`acme/${'b'.repeat(94)}-octo`);
    expect(courseRepository(`acme/${'b'.repeat(96)}-<username>`, 'octo')).toBeUndefined();
    // The login completes `.git` at the end of the name.
    expect(courseRepository('acme/x.gi<username>', 't')).toBeUndefined();
    // A login that is no GitHub login.
    for (const login of ['', '-octo', 'oc to', 'octo/x', 'a'.repeat(40)]) expect(courseRepository('acme/api-<username>', login), login).toBeUndefined();
  });
});
