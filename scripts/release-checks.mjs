// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The check of rule 4 of the release rules of the nimblescape extensions (CONTRIBUTING.md, section "Release rules"): a
// change of the release process is tested with a dry run before it reaches main. The workflows release.yml and
// release-dry-run.yml run it. The other rules have no check. The check only reads: it prints what it found, as GitHub
// annotations, and exits with 1 when the rule is broken.
//
//   node scripts/release-checks.mjs dry-run
//     Environment GITHUB_REPOSITORY, GH_TOKEN and HEAD_SHA. A successful dry run of the workflow "Release" tested the
//     files of the release process, release.yml, ci.yml and this script, as they are at the commit HEAD_SHA. On a pull
//     request (also PR_NUMBER and HEAD_REF), the check applies only when the pull request changes one of these files.
//
// The script is the same in every extension repository of nimblescape.
import { execFileSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

/** The workflow that runs the release. */
export const RELEASE_WORKFLOW = '.github/workflows/release.yml';
/**
 * The files of the release process: a change to one of them needs a dry run (rule 4). The release publishes the VSIX
 * that ci.yml tests and builds.
 */
export const RELEASE_FILES = [RELEASE_WORKFLOW, '.github/workflows/ci.yml', 'scripts/release-checks.mjs'];
/** The end of the run name of a dry run of the workflow "Release" (its `run-name`). */
export const DRY_RUN_SUFFIX = '(dry run)';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The numbers of a version `<major>.<minor>.<patch>`.
 * @param {string} version
 * @returns {number[] | undefined} undefined when the text has another form.
 */
export function parseVersion(version) {
  return VERSION.exec(version)?.slice(1).map(Number);
}

/**
 * Compares two versions of the form `<major>.<minor>.<patch>`.
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative when a is lower than b, 0 when they are equal, positive when a is higher.
 */
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  return x.map((n, i) => n - y[i]).find((d) => d !== 0) ?? 0;
}

/**
 * The newest release tag `v<version>` of a list of tag names. Names of another form do not count.
 * @param {string[]} tags
 * @returns {string | undefined} undefined when no tag counts.
 */
export function newestTag(tags) {
  let newest;
  for (const tag of tags) {
    const version = tag.slice(1);
    if (!tag.startsWith('v') || !parseVersion(version)) continue;
    if (newest === undefined || compareVersions(version, newest.slice(1)) > 0) newest = tag;
  }
  return newest;
}

let failed = false;

function error(text) {
  console.log(`::error::${text}`);
  failed = true;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
}

/** The names of the tags `v*` of the remote origin. */
function releaseTags() {
  return run('git', ['ls-remote', '--tags', '--refs', 'origin', 'refs/tags/v*'])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\trefs/tags/')[1]);
}

async function checkDryRun() {
  const { GITHUB_REPOSITORY: repository, GH_TOKEN: token, HEAD_SHA: head, PR_NUMBER: number, HEAD_REF: branch } = process.env;
  if (!repository || !token || !head || (number && !branch)) {
    error('The check of the dry run needs GITHUB_REPOSITORY, GH_TOKEN and HEAD_SHA, and on a pull request PR_NUMBER and HEAD_REF.');
    return;
  }
  /** The answer of the GitHub API as JSON; undefined for a missing file of a commit (`missing`), else an error. */
  const api = async (request, missing = false) => {
    const response = await fetch(`https://api.github.com/${request}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
    });
    if (missing && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`The GitHub API answered ${request} with HTTP ${response.status}.`);
    return response.json();
  };

  let touched = RELEASE_FILES;
  if (number) {
    const changed = new Set();
    for (let page = 1; ; page++) {
      const files = await api(`repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`);
      for (const file of files) {
        changed.add(file.filename);
        if (file.previous_filename) changed.add(file.previous_filename);
      }
      if (files.length < 100) break;
    }
    touched = RELEASE_FILES.filter((file) => changed.has(file));
    if (touched.length === 0) {
      console.log('The pull request changes no file of the release process.');
      return;
    }
  }

  // The Git blob of each file of the release process at a commit (null for a missing file): equal blobs, equal files.
  const blobs = async (ref) =>
    JSON.stringify(
      await Promise.all(RELEASE_FILES.map(async (file) => (await api(`repos/${repository}/contents/${file}?ref=${ref}`, true))?.sha ?? null)),
    );
  const wanted = await blobs(head);
  // The release of the newest tag ran this check with its files, so the same files need no new dry run. A tag from
  // before the rules lacks a file of the release process and does not count.
  const tag = newestTag(releaseTags());
  const tagged = tag === undefined ? undefined : await blobs(tag);
  if (tagged !== undefined && !JSON.parse(tagged).includes(null) && tagged === wanted) {
    console.log(`The files of the release process at ${head} are the files of the release ${tag}, which passed this check.`);
    return;
  }
  // The touched files as a text, such as `a, b and c`.
  const files = touched.length > 1 ? `${touched.slice(0, -1).join(', ')} and ${touched.at(-1)}` : touched.join('');
  const query = 'event=workflow_dispatch&status=success&per_page=100';
  const runs = (await api(`repos/${repository}/actions/workflows/release.yml/runs?${query}`)).workflow_runs;
  const tested = new Set();
  for (const dryRun of runs.filter((candidate) => candidate.display_title.endsWith(DRY_RUN_SUFFIX))) {
    if (tested.has(dryRun.head_sha)) continue;
    tested.add(dryRun.head_sha);
    if ((await blobs(dryRun.head_sha)) === wanted) {
      console.log(`The dry run ${dryRun.html_url} tested ${files} as they are at ${head}.`);
      return;
    }
  }
  if (number) {
    error(
      `The pull request changes ${files}, and no successful dry run tested them as they are at ${head}. Start the ` +
        `workflow "Release" on the branch ${branch} with "Dry run", then re-run this job. (rule 4)`,
    );
  } else {
    error(
      `No successful dry run tested ${files} as they are at ${head}. Start the workflow "Release" on this branch with ` +
        '"Dry run" first. (rule 4)',
    );
  }
}

// The tests import the functions above; only a start as a program runs the check.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'dry-run' && args.length === 0) await checkDryRun();
    else {
      console.error('Usage: node scripts/release-checks.mjs dry-run');
      process.exit(2);
    }
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause));
  }
  process.exit(failed ? 1 : 0);
}
