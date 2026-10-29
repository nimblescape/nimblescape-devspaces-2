// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// `node scripts/docker-cli-pin.mjs [--version <x.y.z>] [--check]`: writes src/core/docker/dockerCliPin.json, the
// version of the Docker CLI that Devspaces downloads for the windows of devspaces on another computer
// (docs/architecture.md "The Docker CLI of Devspaces"), with the size and the SHA-256 of the file of each platform.
// download.docker.com publishes no checksums for these static builds, so the hashes are computed here from the files
// themselves, once, and the extension checks every download against them. Without --version, the version is the
// newest that all platforms of the pin have. The workflow "Docker CLI" runs this every week and opens a pull request
// when the file changed. --check writes nothing: it downloads the files of the current pin again and fails when a size
// or a hash differs (Docker replaced a file).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pinFile = join(root, 'src', 'core', 'docker', 'dockerCliPin.json');
const BASE = 'https://download.docker.com';
/** The folder and the archive type of each platform key of the pin (ownDockerCli.ts dockerCliPlatformKey). */
const PLATFORMS = {
  'windows-x86_64': { folder: 'win/static/stable/x86_64', extension: 'zip' },
  'mac-x86_64': { folder: 'mac/static/stable/x86_64', extension: 'tgz' },
  'mac-aarch64': { folder: 'mac/static/stable/aarch64', extension: 'tgz' },
  'linux-x86_64': { folder: 'linux/static/stable/x86_64', extension: 'tgz' },
  'linux-aarch64': { folder: 'linux/static/stable/aarch64', extension: 'tgz' },
};

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

async function fetchOk(url) {
  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return response;
}

/** The versions x.y.z of the folder of `platform` (the links of its index page). */
async function versionsOf(platform) {
  const { folder, extension } = PLATFORMS[platform];
  const page = await (await fetchOk(`${BASE}/${folder}/`)).text();
  const pattern = new RegExp(`href="docker-(\\d+\\.\\d+\\.\\d+)\\.${extension}"`, 'g');
  return new Set([...page.matchAll(pattern)].map((match) => match[1]));
}

/** The size and the SHA-256 of the file of `platform` and `version`, from a download of the whole file. */
async function fileOf(platform, version) {
  const { folder, extension } = PLATFORMS[platform];
  const url = `${BASE}/${folder}/docker-${version}.${extension}`;
  const response = await fetchOk(url);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    size += chunk.length;
  }
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) !== size) throw new Error(`GET ${url}: ${size} of ${length} bytes`);
  return { url, size, sha256: hash.digest('hex') };
}

async function main() {
  const args = process.argv.slice(2);
  const current = existsSync(pinFile) ? JSON.parse(readFileSync(pinFile, 'utf8')) : { version: '0.0.0', files: {} };
  if (args.includes('--check')) {
    for (const [platform, file] of Object.entries(current.files)) {
      const now = await fileOf(platform, current.version);
      if (now.size !== file.size || now.sha256 !== file.sha256) throw new Error(`${file.url} changed: ${now.size} bytes, SHA-256 ${now.sha256}`);
      console.log(`${file.url}: unchanged`);
    }
    return;
  }
  const at = args.indexOf('--version');
  const given = at < 0 ? undefined : (args[at + 1] ?? '');
  if (given !== undefined && !/^\d+\.\d+\.\d+$/.test(given)) throw new Error(`--version needs x.y.z: "${given}"`);
  let version = given;
  if (version === undefined) {
    const lists = await Promise.all(Object.keys(PLATFORMS).map(versionsOf));
    const common = [...lists[0]].filter((candidate) => lists.every((list) => list.has(candidate)));
    if (common.length === 0) throw new Error('No version of the Docker CLI exists for all platforms.');
    version = common.sort(compareVersions).at(-1);
  }
  if (version === current.version && given === undefined) {
    console.log(`The pin has the newest version already: ${version}`);
    return;
  }
  if (given === undefined && compareVersions(version, current.version) < 0) throw new Error(`The newest version ${version} is older than the pin ${current.version}.`);
  const files = {};
  for (const platform of Object.keys(PLATFORMS)) files[platform] = await fileOf(platform, version);
  writeFileSync(pinFile, `${JSON.stringify({ version, files }, null, 2)}\n`);
  console.log(`The pin is now ${version}.`);
}

await main();
