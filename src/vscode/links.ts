// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The links to Devspaces, for example on a website: `vscode://nimblescape.nimblescape-devspaces-2/open?repository=owner/name`
// starts the repository owner/name (Controller.openLink). VS Code hands such a link to the extension of its authority,
// and installs that extension from the Marketplace first when it is missing. No `vscode` import, so the rules are
// unit-tested.

/** The path of the link that opens a repository. */
export const OPEN_LINK_PATH = '/open';
/** The query parameter of that link: the repository, `owner/name`. */
export const REPOSITORY_PARAMETER = 'repository';

/** A link that opens a repository, or why the link opens nothing (for the log). */
export type ParsedLink = { kind: 'open'; repository: string } | { kind: 'invalid'; reason: string };

// The characters of GitHub names: an account or organization of at most 39 letters, digits, hyphens and underscores
// that starts with a letter or a digit (the accounts of Enterprise Managed Users end with `_` and a short code; GitHub
// allows no other hyphens in new names, but older names have them); a repository of at most 100 letters, digits, `.`,
// `_` and `-`, but not `.` or `..`, and not ending with `.git` (the address of a clone, which GitHub gives no
// repository). Any other text of a website opens nothing.
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The link of `path` and `query` as `vscode.Uri` gives them: decoded already, so the values are not decoded again (a
 * value that a website encoded twice opens nothing). Only the path `/open` with exactly one parameter `repository`
 * that names a GitHub repository opens something; other parameters are ignored.
 */
export function parseLink(path: string, query: string): ParsedLink {
  if (path !== OPEN_LINK_PATH) return { kind: 'invalid', reason: 'its path is not /open' };
  const values = query
    .split('&')
    .filter((parameter) => parameter.split('=', 1)[0] === REPOSITORY_PARAMETER)
    .map((parameter) => parameter.slice(REPOSITORY_PARAMETER.length + 1));
  if (values.length !== 1) return { kind: 'invalid', reason: `it needs one parameter ${REPOSITORY_PARAMETER}` };
  const repository = values[0];
  const index = repository.indexOf('/');
  const owner = index > 0 ? repository.slice(0, index) : '';
  const name = index > 0 ? repository.slice(index + 1) : '';
  if (!OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name) || name === '.' || name === '..' || name.toLowerCase().endsWith('.git')) {
    return { kind: 'invalid', reason: `its parameter ${REPOSITORY_PARAMETER} is not a GitHub repository owner/name` };
  }
  return { kind: 'open', repository };
}
