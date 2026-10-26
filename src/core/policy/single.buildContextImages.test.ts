// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Probes of singleImageReferences (single.ts). Buildx pulls the image of `--build-context name=docker-image://<image>`
// only by the exact prefix (a value with a space before it, or in another case, is a local path, which the policy
// refuses), and the references are trimmed as that of `image` is. The test pins imageContext of the value as written
// (not of the trimmed value, and not case-insensitive), and the image trimmed.
import { describe, expect, it } from 'vitest';
import { singleImageReferences } from './index';

describe('the images of --build-context, as Buildx pulls them', () => {
  it('asks only about the images of --build-context that Buildx pulls, trimmed', () => {
    const options = ['--build-context', 'a=docker-image://alpine:3 ', '--build-context', 'b= docker-image://busybox:1', '--build-context=c=DOCKER-IMAGE://debian:12', '--build-context', 'd=https://example.com/d.git'];
    expect(singleImageReferences({ build: { dockerfile: 'Dockerfile', options } })).toEqual([{ reference: 'alpine:3', what: 'build option --build-context image' }]);
  });
});
