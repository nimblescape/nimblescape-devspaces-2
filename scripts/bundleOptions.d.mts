// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import type { BuildOptions } from 'esbuild';

export const WORKER_ENTRY: string;
export function sharedBundleOptions(options: { production: boolean }): BuildOptions & { define: Record<string, string> };
export function workerBundleOptions(shared: BuildOptions): BuildOptions;
export function packageBundleOptions(shared: BuildOptions): Array<BuildOptions & { outfile: string }>;
