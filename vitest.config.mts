// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { defineConfig } from 'vitest/config';
import { buildDefines } from './scripts/buildDefines.mjs';

export default defineConfig({
  // The same compile-time constants as in esbuild.mjs (src/types/globals.d.ts).
  define: buildDefines(),
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'node',
  },
});
