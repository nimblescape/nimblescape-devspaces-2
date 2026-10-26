// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The semantics of the shared key checks (hasOnlyKeys, as src/core/helperChannel/protocol.ts uses it, and hasExactKeys,
// as src/core/remoteMonitor/protocol.ts uses it): only the enumerable own string keys count as keys of the value; a
// required key of hasOnlyKeys may be inherited (`in`), one of hasExactKeys must be an own key; a key list is compared
// by its length.
import { describe, expect, it } from 'vitest';
import { hasExactKeys, hasOnlyKeys } from './valueChecks';

function withHidden(value: Record<string, unknown>): Record<string, unknown> {
  Object.defineProperty(value, 'hidden', { value: 1, enumerable: false });
  (value as Record<symbol, unknown>)[Symbol('extra')] = 1;
  return value;
}

describe('the key checks of src/core/valueChecks.ts', () => {
  it('hasOnlyKeys: non-enumerable and symbol keys are not keys beyond the allowed ones', () => {
    expect(hasOnlyKeys(withHidden({ a: 1 }), ['a'])).toBe(true);
    expect(hasOnlyKeys(withHidden({ a: 1 }), ['a'], ['b'])).toBe(true);
  });

  it('hasOnlyKeys: a required key may be inherited (the `in` check of the copy in helperChannel/protocol.ts)', () => {
    expect(hasOnlyKeys(Object.create({ a: 1 }) as Record<string, unknown>, ['a'])).toBe(true);
    expect(hasOnlyKeys(Object.create({ b: 1 }) as Record<string, unknown>, ['a'])).toBe(false);
  });

  it('hasExactKeys: non-enumerable and symbol keys are not counted', () => {
    expect(hasExactKeys(withHidden({ a: 1 }), ['a'])).toBe(true);
  });

  it('hasExactKeys: an inherited key is not an own key, and the key list is compared by its length', () => {
    expect(hasExactKeys(Object.assign(Object.create({ a: 1 }) as Record<string, unknown>, { b: 2 }), ['a'])).toBe(false);
    expect(hasExactKeys({ a: 1 }, ['a', 'a'])).toBe(false);
  });
});
