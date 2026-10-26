// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The key of the remembered check result of a configuration and the hash of an analysis job (see
// src/core/storage/configCheckEntry.ts for the entry and what it holds). In the worker only (the hash takes the job as
// the analysis thread gets it). Pure functions; no I/O, no `vscode`.
import { transferableJob, type AnalysisJob } from '../helper/configurationAnalysis';
import { CONFIG_CHECK_VERSION, canonicalJson, sha256Hex } from '../storage/configCheckEntry';

/** What the CLI results of the open depend on (configCheckKey). */
export interface ConfigCheckInputs {
  helperImageId: string;
  devspaceId: string;
  repository: string;
  volumeName: string;
  configPath: string;
  fallback: boolean;
  hostAccessChecks: string;
  configText: string;
  dockerfilePath?: string;
  dockerfileText?: string;
  dockerfileMissing?: boolean;
  containerId: string;
}

/** The key of the CLI results of the open (see configCheckEntry.ts); throws for an input that is not JSON. */
export function configCheckKey(inputs: ConfigCheckInputs): string {
  return sha256Hex(canonicalJson({ kind: 'devspace-config-check', version: CONFIG_CHECK_VERSION, inputs }));
}

/**
 * The hash of an analysis job as the analysis thread gets it (transferableJob), with CONFIG_CHECK_VERSION; undefined
 * for a job that is not plain JSON (it is then not remembered).
 */
export function analysisJobHash(job: AnalysisJob): string | undefined {
  try {
    return sha256Hex(canonicalJson({ kind: 'devspace-analysis-job', version: CONFIG_CHECK_VERSION, job: transferableJob(job) }));
  } catch {
    return undefined;
  }
}

