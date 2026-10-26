// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// A build argument named `__proto__` (Docker Compose and single container), and the time of the check of the last stage
// name of the Dockerfile of the dev service.
import { describe, expect, it } from 'vitest';
import { composeProjectName, resourceName } from '../names';
import { collectReferences } from '../imageCheck/imageCheck';
import type { DevcontainerConfig } from '../types';
import type { ComposeModel } from './composeModel';
import { composeReferences } from './compose';
import { MAX_DOCKERFILE_LENGTH } from '../imageCheck/dockerfile';
import { runAnalysisJob } from './configurationAnalysis';
import {
  composeAccessReport,
  composeImageReferences,
  singleImageReferences,
  type ComposeAccessInput,
  type HostAccessReport,
} from '../policy';

const ID = '3f2a9c1e-0000-4000-8000-000000000000';
// One name per devspace (resourceName): the project, the volume, and the container share it.
const PROJECT = composeProjectName('acme/api', ID);
const OWN = resourceName('acme/api', ID);
/** The name of a devspace of another repository and ID. */
const OTHER = resourceName('acme/web', '11111111-2222-4333-8444-555555555555');
const REPO = '/workspaces/api';

/** A model of `docker compose config` whose dev service builds with `build` (parsed from JSON, as the model run does). */
function model(build: Record<string, unknown>): ComposeModel {
  return JSON.parse(
    JSON.stringify({
      name: PROJECT,
      services: { app: { build: { context: `${REPO}/.devcontainer`, dockerfile: 'Dockerfile', ...build }, command: ['sleep', 'infinity'] } },
    }),
  ) as ComposeModel;
}

/** A build argument named `__proto__` as an own property (JSON.parse, js-yaml, and Object.fromEntries keep it so). */
function protoArgs(value: string): Record<string, unknown> {
  return JSON.parse(`{ "__proto__": ${JSON.stringify(value)} }`) as Record<string, unknown>;
}

function input(build: Record<string, unknown>, dockerfile: string): ComposeAccessInput {
  return {
    model: model(build),
    devService: 'app',
    project: PROJECT,
    repositoryFolder: REPO,
    ownVolume: OWN,
    engineApiVersion: '1.47',
    dockerfiles: { app: dockerfile },
  };
}

function refused(report: HostAccessReport): string[] {
  return [...report.hostAccess, ...report.unsupported];
}

describe('a build argument named __proto__', () => {
  it('is an own property of the parsed model', () => {
    const args = protoArgs('x');
    expect(Object.keys(args)).toEqual(['__proto__']);
  });

  it('Docker Compose: allows FROM the image of another devspace through it', () => {
    const report = composeAccessReport(input({ args: protoArgs(`${OTHER}:3`) }, 'ARG __proto__\nFROM $__proto__\n'));
    // The images of the Dockerfiles are not checked.
    expect(refused(report)).toEqual([]);
  });

  it('Docker Compose: the references of the image check hold its image', () => {
    const m = model({ args: protoArgs('cafe1234') });
    // The Dockerfile images are no image references for the question of image IDs.
    expect(composeImageReferences(m)).toEqual([]);
    expect(composeReferences(m, { app: 'ARG __proto__\nFROM $__proto__\n' }, undefined).images).toContain('cafe1234');
  });

  it('single container: `--build-arg __proto__=…` of build.options is allowed with the Dockerfile', () => {
    const config = { build: { dockerfile: 'Dockerfile', options: ['--build-arg', `__proto__=${OTHER}:3`] } };
    const analysis = runAnalysisJob({ kind: 'single', input: { config, ownVolume: OWN }, checksOn: true, config, dockerfileText: 'ARG __proto__\nFROM $__proto__\n' });
    // The images of the Dockerfile are not checked, and `cafe1234` is no image reference for the question of image IDs.
    expect(refused(analysis.report)).toEqual([]);
    expect(analysis.imageReferences).toEqual([]);
    expect(singleImageReferences({ build: { dockerfile: 'Dockerfile', options: ['--build-arg', '__proto__=cafe1234'] } })).toEqual([]);
  });

  it('single container: the image check reads it from build.args of a parsed configuration', () => {
    const config = JSON.parse('{ "build": { "dockerfile": "Dockerfile", "args": { "__proto__": "node:22" } } }') as DevcontainerConfig;
    expect(collectReferences(config, 'ARG __proto__\nFROM $__proto__\n').images).toEqual(['node:22']);
  });
});

describe('Docker\'s view: an image of the Dockerfile', () => {
  const config = { build: { dockerfile: 'Dockerfile' } };
  const single = (dockerfile: string) =>
    runAnalysisJob({ kind: 'single', input: { config, ownVolume: OWN }, checksOn: true, config, dockerfileText: dockerfile });

  it('allows an image of another devspace, and names it only for the update check', () => {
    // The images of the Dockerfile are not checked (single and Compose), and `cafe1234` is no image reference for the
    // question of image IDs.
    expect(refused(single(`FROM ${OTHER}:2\n`).report)).toEqual([]);
    expect(refused(composeAccessReport(input({}, `FROM ${OTHER}:2\n`)))).toEqual([]);
    expect(single('FROM cafe1234\n').imageReferences).toEqual([]);
    expect(single('FROM cafe1234\n').references.images).toEqual(['cafe1234']);
  });

  it('refuses a Dockerfile of the dev service that is longer than the model run reads (the build writes the text it read)', () => {
    const long = `FROM alpine\n# ${'x'.repeat(MAX_DOCKERFILE_LENGTH)}\n`;
    expect(composeAccessReport(input({}, long)).unsupported).toEqual([
      `service app: the Dockerfile (longer than ${MAX_DOCKERFILE_LENGTH} characters; the dev service is built from the text that Devspaces read)`,
    ]);
    expect(composeAccessReport(input({}, long), false).unsupported).toHaveLength(1);
    // The same Dockerfile of another service is refused too (a size limit): the configuration hash sees only the text
    // that the model run read, so an edit after it would offer no rebuild.
    const other: ComposeAccessInput = { ...input({}, 'FROM alpine\n'), model: { name: PROJECT, services: { ...model({}).services, db: { build: { context: REPO } } } }, dockerfiles: { app: 'FROM alpine\n', db: long } };
    expect(composeAccessReport(other)).toEqual({
      hostAccess: [],
      unsupported: [`service db: the Dockerfile (longer than ${MAX_DOCKERFILE_LENGTH} characters; the Dockerfile is too large)`],
    });
  });

  it('refuses a Dockerfile of a side service of MAX_DOCKERFILE_LENGTH + 1 characters, whatever the switch says', () => {
    const long = `FROM alpine\n#${'x'.repeat(MAX_DOCKERFILE_LENGTH - 12)}`;
    expect(long.length).toBe(MAX_DOCKERFILE_LENGTH + 1);
    const side = (text: string): ComposeAccessInput => ({
      ...input({}, 'FROM alpine\n'),
      model: { name: PROJECT, services: { ...model({}).services, db: { build: { context: REPO } } } },
      dockerfiles: { app: 'FROM alpine\n', db: text },
    });
    const item = `service db: the Dockerfile (longer than ${MAX_DOCKERFILE_LENGTH} characters; the Dockerfile is too large)`;
    expect(composeAccessReport(side(long)).unsupported).toEqual([item]);
    expect(composeAccessReport(side(long), false).unsupported).toEqual([item]);
    // A Dockerfile of exactly MAX_DOCKERFILE_LENGTH characters, and a normal one, are allowed.
    expect(composeAccessReport(side(long.slice(0, -1)))).toEqual({ hostAccess: [], unsupported: [] });
    expect(composeAccessReport(side('FROM alpine\nRUN echo hi\n'))).toEqual({ hostAccess: [], unsupported: [] });
  });
});

describe('long runs of blank lines', () => {
  it('refuses the Dockerfile of the dev service quickly when its last stage name is read', () => {
    const dockerfile = 'FROM mcr.microsoft.com/devcontainers/base:bookworm AS dev\nUSER vscode\n' + ' \n'.repeat(60_000) + 'RUN x';
    const started = Date.now();
    expect(composeAccessReport(input({}, dockerfile)).unsupported.join('\n')).toContain('too many blank lines in a row');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('with a build target, the last stage name is not read, and the check finishes quickly', () => {
    // The user that the Dev Container CLI computes with Features (its reader) is not modelled, so with a target nothing
    // reads the whole Dockerfile line by line; the check must still be fast and refuse nothing.
    const dockerfile = 'FROM mcr.microsoft.com/devcontainers/base:bookworm AS dev\nUSER vscode\n' + ' \n'.repeat(60_000) + 'RUN x';
    const started = Date.now();
    expect(composeAccessReport(input({ target: 'dev' }, dockerfile)).unsupported.join('\n')).not.toContain('too many blank lines in a row');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
