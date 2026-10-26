// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Mutation tests: the strictness of the answer of delete and of the busy mark.
import { describe, expect, it } from 'vitest';
import { parseDeleteValue } from './protocol';
import { parseBusyMarkAnswer } from '../worker/workerHostSide';

describe('the answers of delete and of the busy mark', () => {
  it('a refusal with another key is invalid', () => {
    expect(parseDeleteValue({ refused: { code: 'otherAccount', message: 'x' } })).toBeDefined();
    expect(parseDeleteValue({ refused: { code: 'otherAccount', message: 'x' }, deleted: true })).toBeUndefined();
  });
  it('a conflict that is not a busy mark is a failure of the request', () => {
    const mark = { operation: 'update', since: '2026-10-04T10:00:00.000Z', pid: 7, windowId: 'w2' };
    expect(parseBusyMarkAnswer({ conflict: mark }, 'e1')).toEqual({ conflict: mark });
    for (const odd of [{ ...mark, since: 1 }, { ...mark, pid: 1.5 }, { ...mark, windowId: 2 }]) {
      expect(() => parseBusyMarkAnswer({ conflict: odd }, 'e1'), JSON.stringify(odd)).toThrow('invalid value');
    }
  });
});
