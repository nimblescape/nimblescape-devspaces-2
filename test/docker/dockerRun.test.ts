// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The check for leftovers of the Docker tests (unexpectedChanges) and the removal of the objects of a run
// (removeRunObjects), without Docker calls.
import { describe, expect, it } from 'vitest';
import { removeRunObjects, unexpectedChanges, type DockerCli, type DockerResult, type DockerSnapshot } from './dockerRun';

const ID_USER = `sha256:${'1'.repeat(64)}`;
const ID_PULLED = `sha256:${'2'.repeat(64)}`;

function snapshot(images: DockerSnapshot['images']): DockerSnapshot {
  return { containers: [], volumes: [], images };
}

describe('unexpectedChanges', () => {
  it('reports a tag of the baseline that is gone, also an allowed one, while its image stays', () => {
    // A pull moved the tag of the user to a newer image, and a removal of that image took the tag with it.
    const baseline = snapshot([{ id: ID_USER, tags: ['alpine:3.22'] }]);
    const current = snapshot([{ id: ID_USER, tags: [] }]);
    expect(unexpectedChanges(baseline, current, ['alpine:3.22'])).toEqual([`tag alpine:3.22 of the baseline image ${ID_USER.slice(7, 19)} is gone`]);
  });

  it('reports a tag of the baseline that moved to another image, unless it is allowed', () => {
    const baseline = snapshot([{ id: ID_USER, tags: ['alpine:3.22'] }]);
    const current = snapshot([
      { id: ID_USER, tags: [] },
      { id: ID_PULLED, tags: ['alpine:3.22'] },
    ]);
    expect(unexpectedChanges(baseline, current, [])).toEqual([
      `new image ${ID_PULLED.slice(7, 19)} alpine:3.22`,
      `tag alpine:3.22 of the baseline moved to ${ID_PULLED.slice(7, 19)}`,
    ]);
    // A pulled base image or a rebuilt helper image of the tests may take its tag.
    expect(unexpectedChanges(baseline, current, ['docker.io/library/alpine:3.22'])).toEqual([]);
  });

  it('reports nothing when the images and tags of the baseline are unchanged', () => {
    const baseline = snapshot([{ id: ID_USER, tags: ['alpine:3.22', 'mine:1'] }]);
    expect(unexpectedChanges(baseline, snapshot([{ id: ID_USER, tags: ['mine:1', 'alpine:3.22'] }]), [])).toEqual([]);
  });
});

describe('removeRunObjects', () => {
  /** A Docker CLI of images only: `image rm -f` refuses an image that has a child, as the engine does. */
  function fakeDocker(parents: Record<string, string | undefined>, listed: string[]): { docker: DockerCli; removed: string[] } {
    const present = new Set(Object.keys(parents));
    const removed: string[] = [];
    const run = (args: readonly string[]): DockerResult => {
      if (args[0] === 'image' && args[1] === 'ls') return { code: 0, out: listed.join('\n'), err: '' };
      if (args[0] === 'image' && args[1] === 'rm') {
        const id = args[3];
        if (!present.has(id)) return { code: 1, out: '', err: `Error response from daemon: No such image: ${id}` };
        if ([...present].some((other) => parents[other] === id)) {
          return { code: 1, out: '', err: `Error response from daemon: conflict: unable to delete ${id.slice(7, 19)} (cannot be forced) - image has dependent child images` };
        }
        present.delete(id);
        removed.push(id);
        return { code: 0, out: '', err: '' };
      }
      return { code: 0, out: '', err: '' };
    };
    const docker = {
      run,
      ok: (args: readonly string[]) => run(args).out,
      lines: (args: readonly string[]) => run(args).out.split('\n').filter((line) => line !== ''),
    } as unknown as DockerCli;
    return { docker, removed };
  }

  // A commit (labelImage) makes a child of an image of the run, with its labels; the list can name the parent first.
  it('removes a child image before its parent, whatever the order of the list', () => {
    const parent = `sha256:${'a'.repeat(64)}`;
    const child = `sha256:${'b'.repeat(64)}`;
    const grandchild = `sha256:${'c'.repeat(64)}`;
    const { docker, removed } = fakeDocker({ [parent]: undefined, [child]: parent, [grandchild]: child }, [parent, child, grandchild]);
    expect(removeRunObjects(docker, 'run1')).toEqual([`image ${grandchild.slice(7, 19)}`, `image ${child.slice(7, 19)}`, `image ${parent.slice(7, 19)}`]);
    expect(removed).toEqual([grandchild, child, parent]);
  });

  it('fails when a pass removes no image', () => {
    const parent = `sha256:${'a'.repeat(64)}`;
    const child = `sha256:${'b'.repeat(64)}`;
    // The child is not an image of the run: the parent cannot go.
    const { docker } = fakeDocker({ [parent]: undefined, [child]: parent }, [parent]);
    expect(() => removeRunObjects(docker, 'run1')).toThrow(/docker image rm -f sha256:a+ failed: .*dependent child images/);
  });
});
