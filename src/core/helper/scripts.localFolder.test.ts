// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// localFolder (COMPOSE_MODEL_SCRIPT, scripts.ts) and localContextPath (../policy/dockerFlags.ts) must agree. The policy
// looks up the real path of the folder that localContextPath gives for an
// additional context (helperInputProblems: a link out of the repository, to a path of the workspace helper), and the
// model run resolves the folder that localFolder gives; a folder that the policy checks and the model run did not
// resolve has no real path in the check, so a link of the repository out of it passes as a folder of the repository.
// The test of scripts.test.ts has values without blanks and paths without a prefix inside. This test pins that the two
// give the same absolute folders, whatever they do with blanks; each of these wrong variants fails it:
// - localFolder takes a prefix anywhere in the value (`…/target:x`, `…/https://x` no folder);
// - localFolder does not trim, or trims only the start or only the end (localContextPath trims both);
// - localContextPath takes `target:` or `service:` anywhere in the value;
// - localContextPath does not trim, or trims only the start or only the end (localFolder trims both).
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeModelCommand } from './scripts';
import { parseComposeModelOutput } from './compose';
import { localContextPath } from '../policy';
import { composeProjectName } from '../names';

const PROJECT = composeProjectName('acme/api', '3f2a9c1e-0000-4000-8000-000000000000');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The real paths of the model run of `model` in a temporary repository, with a fake `docker` on PATH: `compose version
 * --short` prints 2.29.1, the probe prints a `$` unescaped (no `$$`), `config` prints the model.
 */
function realPathsOf(model: (repo: string) => unknown): { repo: string; realPaths: Record<string, string | null> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-test-'));
  tempDirs.push(dir);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'layout'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'));
  const fake = [
    '#!/bin/sh',
    'shift',
    'if [ "$1 $2" = "version --short" ]; then echo 2.29.1; exit 0; fi',
    'case "$*" in',
    '  *"-p devspaces-probe"*) cat > /dev/null; printf \'%s\\n\' "$FAKE_PROBE"; exit 0 ;;',
    'esac',
    'printf \'%s\\n\' "$FAKE_MODEL"',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'bin', 'docker'), `${fake}\n`);
  fs.chmodSync(path.join(dir, 'bin', 'docker'), 0o755);
  const env = {
    ...process.env,
    PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    COMPOSE_PROJECT_NAME: PROJECT,
    FAKE_PROBE: JSON.stringify({ services: { probe: { environment: { V: 'a$b' } } } }),
    FAKE_MODEL: JSON.stringify(model(repo)),
  };
  const command = composeModelCommand(repo, [path.join(repo, 'compose.yml')]);
  const result = spawnSync(process.execPath, command.slice(1), { encoding: 'utf8', env });
  expect(result.status, result.stderr).toBe(0);
  const output = parseComposeModelOutput(result.stdout);
  if ('error' in output) throw new Error(output.error);
  return { repo, realPaths: output.realPaths };
}

describe('localFolder and localContextPath', () => {
  it('resolves exactly the folders of the additional contexts that the policy checks', () => {
    const values = (repo: string): string[] => [
      `${repo}/a`,
      `${repo}/b `,
      ` ${repo}/c`,
      `${repo}/d\n`,
      `\t${repo}/e `,
      `oci-layout://${repo}/layout:1`,
      ` oci-layout://${repo}/f:1 `,
      `${repo}/g/target:x`,
      `${repo}/h/service:x`,
      `${repo}/i/docker-image://x`,
      `${repo}/j/https://x`,
      `${repo}/k/http://x`,
      'docker-image://alpine',
      'https://example.com/x.git',
      'http://example.com/x.tar.gz',
      'target:base',
      'service:app',
      'cwd:///devspace-cache',
      'TARGET:base',
      ' service:app',
    ];
    const { repo, realPaths } = realPathsOf((r) => ({
      name: PROJECT,
      services: {
        app: { image: 'mcr.microsoft.com/devcontainers/base:bookworm', command: ['sleep', 'infinity'] },
        db: { build: { context: r, dockerfile_inline: 'FROM alpine', additional_contexts: Object.fromEntries(values(r).map((value, i) => [`c${i}`, value])) } },
      },
    }));
    const checked = values(repo)
      .map((value) => localContextPath(value))
      .filter((folder): folder is string => folder !== undefined && folder.startsWith('/'));
    // The build context and the folders of the additional contexts that the policy checks as absolute paths, no more.
    expect(new Set(Object.keys(realPaths))).toEqual(new Set([repo, ...checked]));
    // Not vacuous: plain folders, an OCI layout, and folders whose path holds a prefix are among them.
    for (const folder of [`${repo}/a`, `${repo}/layout`, `${repo}/g/target:x`, `${repo}/h/service:x`, `${repo}/i/docker-image://x`, `${repo}/j/https://x`]) {
      expect(checked, folder).toContain(folder);
    }
    expect(realPaths[`${repo}/layout`]).toBe(fs.realpathSync(path.join(repo, 'layout')));
  });
});
