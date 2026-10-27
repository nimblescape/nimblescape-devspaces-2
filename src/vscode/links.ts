// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The links to Devspaces, for example on a website: `vscode://nimblescape.nimblescape-devspaces-2/open?repository=owner/name`
// starts the repository owner/name (Controller.openLink). The course link
// `vscode://nimblescape.nimblescape-devspaces-2/course?repository=owner/name-<username>` starts the repository of the
// signed-in account in a course: `<username>` becomes the GitHub login of the account, as GitHub Classroom names the
// repository of each student. VS Code hands such a link to the extension of its authority, and installs that extension
// from the Marketplace first when it is missing. No `vscode` import, so the rules are unit-tested.

/** The path of the link that opens a repository. */
export const OPEN_LINK_PATH = '/open';
/** The path of the course link, which opens the repository of the signed-in account in a course. */
export const COURSE_LINK_PATH = '/course';
/** The query parameter of both links: the repository, `owner/name`. */
export const REPOSITORY_PARAMETER = 'repository';
/**
 * The placeholder in the name of a course link, for the GitHub login of the signed-in account. A course link without it
 * gets `-<username>` at the end of the name.
 */
export const USERNAME_PLACEHOLDER = '<username>';

/** A link that opens a repository, or why the link opens nothing (for the log). */
export type ParsedLink = RepositoryLink | { kind: 'invalid'; reason: string };
/**
 * A link that opens a repository: `/open` with the repository, or a course link, whose `template` is `owner/name` with
 * at least one USERNAME_PLACEHOLDER in the name (courseRepository).
 */
export type RepositoryLink = { kind: 'open'; repository: string } | { kind: 'course'; template: string };

// The characters of GitHub names: an account or organization of at most 39 letters, digits, hyphens and underscores
// that starts with a letter or a digit (the accounts of Enterprise Managed Users end with `_` and a short code; GitHub
// allows no other hyphens in new names, but older names have them); a repository of at most 100 letters, digits, `.`,
// `_` and `-`, but not `.` or `..`, and not ending with `.git` (the address of a clone, which GitHub gives no
// repository). Any other text of a website opens nothing.
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** The owner and the name of `owner/name`, or `undefined` when it is no GitHub repository. */
function repositoryParts(repository: string): { owner: string; name: string } | undefined {
  const index = repository.indexOf('/');
  const owner = index > 0 ? repository.slice(0, index) : '';
  const name = index > 0 ? repository.slice(index + 1) : '';
  if (!OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name) || name === '.' || name === '..' || name.toLowerCase().endsWith('.git')) return undefined;
  return { owner, name };
}

/**
 * The link of `path` and `query` as `vscode.Uri` gives them: decoded already, so the values are not decoded again (a
 * value that a website encoded twice opens nothing). Only the path `/open` or `/course` with exactly one parameter
 * `repository` that names a GitHub repository opens something; other parameters are ignored. In a course link, the
 * name of the repository can hold USERNAME_PLACEHOLDER; without it, the link gets `-<username>` at the end of the name.
 */
export function parseLink(path: string, query: string): ParsedLink {
  if (path !== OPEN_LINK_PATH && path !== COURSE_LINK_PATH) return { kind: 'invalid', reason: 'its path is not /open or /course' };
  const values = query
    .split('&')
    .filter((parameter) => parameter.split('=', 1)[0] === REPOSITORY_PARAMETER)
    .map((parameter) => parameter.slice(REPOSITORY_PARAMETER.length + 1));
  if (values.length !== 1) return { kind: 'invalid', reason: `it needs one parameter ${REPOSITORY_PARAMETER}` };
  if (path === OPEN_LINK_PATH) {
    if (repositoryParts(values[0])) return { kind: 'open', repository: values[0] };
    return { kind: 'invalid', reason: `its parameter ${REPOSITORY_PARAMETER} is not a GitHub repository owner/name` };
  }
  const template = values[0].includes(USERNAME_PLACEHOLDER) ? values[0] : `${values[0]}-${USERNAME_PLACEHOLDER}`;
  // The owner is the organization of the course, without the placeholder. The placeholder stands for a login of one
  // character here, the shortest: a name that is too long with the login of the account fails in courseRepository.
  const owner = template.slice(0, Math.max(template.indexOf('/'), 0));
  if (!owner.includes(USERNAME_PLACEHOLDER) && repositoryParts(withLogin(template, 'a'))) return { kind: 'course', template };
  return { kind: 'invalid', reason: `its parameter ${REPOSITORY_PARAMETER} is not a GitHub repository owner/name-${USERNAME_PLACEHOLDER}` };
}

/**
 * The repository `owner/name` of a course link for the GitHub login of the signed-in account: every USERNAME_PLACEHOLDER
 * of the template becomes the login. `undefined` when the result is no GitHub repository, for example a name longer
 * than 100 characters.
 */
export function courseRepository(template: string, login: string): string | undefined {
  if (!OWNER_PATTERN.test(login)) return undefined;
  const repository = withLogin(template, login);
  return repositoryParts(repository) ? repository : undefined;
}

function withLogin(template: string, login: string): string {
  return template.split(USERNAME_PLACEHOLDER).join(login);
}
