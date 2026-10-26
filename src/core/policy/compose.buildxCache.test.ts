// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Probes of compose.ts. Buildx 0.37.2 reads an entry of `cache_from` by util/buildflags/cache.go: without `=` each CSV
// field is the reference of a registry image; else the fields of go-csvvalue (one record: only a trailing line break is
// dropped, one inside the text is part of a field), keys in lower case and not trimmed, values as they are, the last
// `type` counting; only the exact type `local` reads a local folder (BuildKit's client). cacheFromIsRegistry takes
// exactly one `type` field with exactly the value `registry`; the tests in composeAccess.test.ts pin a second `type`
// after `type=registry` and keys in another case, not the rest. The tests here pin:
// - a text that csvFields cannot read (a line break) is refused, not read with `text.split(',')` (as optionFields does)
//   and without a TypeError. Buildx reads `type=registry,"type=local",a=b\n,src=/tmp/c` as one record whose quoted
//   second `type` wins: a local cache import from /tmp/c of the workspace helper.
// - exactly one `type` field (not the last one, not at least or at most one), counted also with spaces around its key
//   (the key not trimmed), with exactly the value `registry` (not trimmed, not compared case-insensitively; the empty
//   text is no registry reference). Each such entry is one that Buildx 0.37.2 reads as a registry import or refuses, so
//   the test pins the documented rule, which does not depend on which of several types Buildx takes or on how it spells
//   a key.
// - buildProblems trims the entry: the item names a refused entry without the spaces around it.
// - an additional context is not taken for a URL after trimming (` https://…` is a path for Buildx).
// - the image of an additional context is checked (an image ID stays refused).
// - composeImageReferences takes an image by the exact prefix only (not after trimming, not case-insensitively), and
//   trims it as it trims the `image` of a service.
import { describe, expect, it } from 'vitest';
import type { ComposeModel } from '../helper/composeModel';
import { composeProjectName, resourceName } from '../names';
import { cacheFromIsRegistry, composeAccessReport, composeImageReferences, type ComposeAccessInput, type HostAccessReport } from './index';

const ID = '3f2a9c1e-0000-4000-8000-000000000000';
const PROJECT = composeProjectName('acme/api', ID);
const REPO = '/workspaces/api';
const NONE: HostAccessReport = { hostAccess: [], unsupported: [] };
const A = (...items: string[]): HostAccessReport => ({ hostAccess: items, unsupported: [] });
const U = (...items: string[]): HostAccessReport => ({ hostAccess: [], unsupported: items });

/** A model that the policy allows (the dev service `app`), and the service `db` built with `build`. */
function model(build: Record<string, unknown>): ComposeModel {
  return {
    name: PROJECT,
    services: {
      app: {
        build: { context: `${REPO}/.devcontainer`, dockerfile: 'Dockerfile' },
        command: ['sleep', 'infinity'],
        volumes: [{ type: 'bind', source: '/workspaces', target: '/workspaces' }],
      },
      db: { build: { context: REPO, ...build } },
    },
    networks: { default: { name: `${PROJECT}_default` } },
  };
}

function report(build: Record<string, unknown>): HostAccessReport {
  const input: ComposeAccessInput = {
    model: model(build),
    devService: 'app',
    project: PROJECT,
    repositoryFolder: REPO,
    ownVolume: resourceName('acme/api', ID),
    engineApiVersion: '1.47',
    devspace: { id: ID, ownerId: '42' },
  };
  return composeAccessReport(input);
}

describe('cache imports, additional contexts and images of a build of Docker Compose, as Buildx reads them', () => {
  it('refuses a cache import with a line break, which Buildx reads as one record with a second type', () => {
    const entry = 'type=registry,"type=local",a=b\n,src=/tmp/c';
    expect(cacheFromIsRegistry(entry)).toBe(false);
    expect(report({ cache_from: [entry] })).toEqual(U(`service db: build cache_from ${entry}`));
  });

  it('takes a cache import only with exactly one type field whose value is exactly registry', () => {
    for (const entry of ['acme/cache:1', 'acme/a,acme/b', 'type=registry', 'type=registry,ref=acme/cache', 'TYPE=registry,ref=acme/cache', 'type=registry,"ref=acme/cache"']) {
      expect(cacheFromIsRegistry(entry), entry).toBe(true);
    }
    const refused = [
      '', // No reference (Buildx skips an empty entry).
      'type=local,src=/tmp/c,type=registry', // The last type is `registry`, but there are two.
      'type=registry,type=registry', // Two type fields.
      'type=registry, type=local,src=/tmp/c', // A second type field, with a space before its key.
      'ref=acme/cache', // No type field (Buildx: "type required").
      'type= registry', // The type ` registry`, which BuildKit does not know.
      'type=registry ', // The type `registry `.
      'type=Registry', // The type `Registry`.
    ];
    for (const entry of refused) expect(cacheFromIsRegistry(entry), JSON.stringify(entry)).toBe(false);
    expect(report({ cache_from: ['type= registry', 'type=local,src=/tmp/c,type=registry', 'type=registry,type=registry'] })).toEqual(
      U('service db: build cache_from type= registry', 'service db: build cache_from type=local,src=/tmp/c,type=registry', 'service db: build cache_from type=registry,type=registry'),
    );
  });

  it('names a refused cache import without the spaces around it', () => {
    expect(report({ cache_from: ['  type=local,src=/tmp/c  ', ' acme/cache:1 '] })).toEqual(U('service db: build cache_from type=local,src=/tmp/c'));
  });

  it('refuses an additional context of a URL after a space, a path for Buildx', () => {
    // Buildx reads it as a path relative to its working folder, so it is also refused whatever the switch says.
    expect(report({ additional_contexts: { x: ' https://example.com/x.git' } })).toEqual(
      A('service db: build additional_contexts x= https://example.com/x.git', 'service db: build additional_contexts x= https://example.com/x.git (a relative path)'),
    );
    expect(report({ additional_contexts: { a: 'http://example.com/a.tar.gz', b: 'https://example.com/b.git' } })).toEqual(NONE);
  });

  it('refuses the image ID of an additional context', () => {
    expect(report({ additional_contexts: { x: 'docker-image://sha256:abc' } })).toEqual(U('service db: build additional_contexts x image sha256:abc (an image ID; name the image)'));
  });

  it('asks only about the images that Buildx pulls, trimmed', () => {
    const m = model({ additional_contexts: { a: 'docker-image://alpine:3 ', b: ' docker-image://busybox:1', c: 'DOCKER-IMAGE://debian:12', d: 'https://example.com/d.git' } });
    expect(composeImageReferences(m)).toEqual([{ reference: 'alpine:3', what: 'service db: build additional_contexts a image' }]);
  });
});
