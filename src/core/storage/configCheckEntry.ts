// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The remembered check result of a configuration. The open of a single container reads devcontainer.json twice with the
// Dev Container CLI (`read-configuration`, plain and with the merged configuration) and runs the host access analysis
// on both (Step 5, DevspaceService.loadConfiguration). When nothing that those results depend on changed, the open
// takes them from the entry that the extension remembers for the devspace (ConfigCheckEntry), and skips the two CLI
// runs and the two analyses:
//   - the two CLI results (`config`, and the raw merged configuration) under `key`, the hash of everything that the CLI
//     reads or that decides its output (configCheckKey: the exact text of devcontainer.json and of the Dockerfile that the
//     open read, the path of the configuration, the repository folder, the devspace ID (the ID label, and
//     `${devcontainerId}`), the full ID of the existing container (the CLI merges its label devcontainer.metadata and
//     substitutes `${containerEnv:…}` with its environment; both are fixed for a container ID), the helper image ID (the
//     version of the CLI and the variables of its process), the switch of the host access checks, and
//     CONFIG_CHECK_VERSION). Only with a container: without one, the CLI reads the base image and the Features for the
//     merged configuration from the registries, whose tags change without a change of any of these inputs;
//   - each analysis result under the hash of its whole job (analysisJobHash): the analysis is a pure function of its job,
//     which holds the configuration, the merged configuration, the Dockerfile and everything that the policy read from
//     Docker and the registry of this computer (the volumes, their labels, the networks, the devspaces of other
//     accounts; hostAccessInput), so that state is read afresh at each open and a change of it runs the analysis again.
//     The image references that Docker resolves by an ID (imageIdItems) and the image metadata check before `up` are
//     never taken from the entry.
// The extension keeps the entry (it is the trusted side; neither the worker nor the engine stores it), checks its shape
// and size here (parseConfigCheckEntry) before it stores it and again before it answers with it, and stamps it with the
// hash of the worker's code that computed it (an entry of other code is not given out). The worker only asks for the
// entry of the devspace of its operation and offers a new one after a check that passed; a refusal is never stored.
// The entry and its strict check; the key and the hash of an analysis job (which need the pipeline) are in
// src/core/pipeline/configCheck.ts. Here, outside the pipeline folders, because the extension's bundle takes this
// module. Pure functions; no I/O, no `vscode`.
import { createHash } from 'crypto';
import type { AnalysisResults } from '../helper/configurationAnalysis';
import { isRecord } from '../valueChecks';

/**
 * The version of the remembered check result. Raise it with any change of what the open takes from the entry or of how
 * it uses it (the policy itself is covered by the hash of the worker's code that the extension stamps).
 */
export const CONFIG_CHECK_VERSION = 1;
/** The largest entry, in characters of its JSON (a larger one is not stored, and not used). */
export const MAX_CONFIG_CHECK_CHARACTERS = 1024 * 1024;
/** The most analysis results of an entry (the open runs two: devcontainer.json, and with the merged one). */
export const MAX_CONFIG_CHECK_ANALYSES = 2;
/** The deepest nesting of a value of an entry (a configuration is a few levels deep). */
const MAX_DEPTH = 64;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The result of a single-container analysis (AnalysisResults['single']) that passed: no refused item, no failure. */
export type PassedAnalysis = Omit<AnalysisResults['single'], 'failure'>;

/** The remembered check result of the configuration of one devspace. */
export interface ConfigCheckEntry {
  /** configCheckKey of the CLI results. */
  key: string;
  /** `configuration` of `read-configuration` (devcontainer.json as the CLI resolves it). */
  config: Record<string, unknown>;
  /** `mergedConfiguration` of `read-configuration --include-merged-configuration`, as the CLI gave it. */
  merged: Record<string, unknown>;
  /** The analyses that passed, each under analysisJobHash of its job. */
  analyses: { job: string; result: PassedAnalysis }[];
}

/**
 * `value` as JSON, strictly: only null, booleans, finite numbers, strings, arrays and plain objects (in the order of
 * their keys; `undefined` of a key is written as a marker of its own, so a key without a value and a missing key
 * differ). Anything else (a function, a Map, a Set, a symbol, a number that is not finite, a cycle, a nesting deeper
 * than MAX_DEPTH) throws: such a value is never hashed or stored.
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const write = (item: unknown, depth: number): string => {
    if (depth > MAX_DEPTH) throw new Error('The value is nested too deeply.');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('The value holds a number that is not finite.');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new Error(`The value holds a ${typeof item}.`);
    if (seen.has(item)) throw new Error('The value holds a cycle.');
    seen.add(item);
    try {
      if (Array.isArray(item)) return `[${item.map((entry) => (entry === undefined ? '{"$undefined":1}' : write(entry, depth + 1))).join(',')}]`;
      const prototype = Object.getPrototypeOf(item) as unknown;
      if (prototype !== Object.prototype && prototype !== null) throw new Error('The value holds an object that is not plain.');
      const fields = Object.keys(item).map((key) => {
        const field = (item as Record<string, unknown>)[key];
        return `${JSON.stringify(key)}:${field === undefined ? '{"$undefined":1}' : write(field, depth + 1)}`;
      });
      return `{${fields.join(',')}}`;
    } finally {
      seen.delete(item);
    }
  };
  return write(value, 0);
}

/** The sha256 of `text` (UTF-8), in hex. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function texts(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((entry) => typeof entry === 'string');
}

/** A result of a single-container analysis that passed, rebuilt from its fields; undefined for anything else. */
function passedAnalysis(value: unknown): PassedAnalysis | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !['report', 'imageReferences', 'references'].includes(key))) return undefined;
  const { report, imageReferences, references } = value;
  // Never a refusal: an empty report only.
  if (!isRecord(report) || Object.keys(report).length !== 2 || !texts(report.hostAccess, 0) || !texts(report.unsupported, 0)) return undefined;
  if (!Array.isArray(imageReferences) || imageReferences.length > 10_000) return undefined;
  const named: PassedAnalysis['imageReferences'] = [];
  for (const entry of imageReferences) {
    if (!isRecord(entry) || Object.keys(entry).length !== 2 || typeof entry.what !== 'string' || typeof entry.reference !== 'string') return undefined;
    named.push({ what: entry.what, reference: entry.reference } as PassedAnalysis['imageReferences'][number]);
  }
  if (!isRecord(references) || Object.keys(references).length !== 2 || !texts(references.images, 10_000) || !texts(references.features, 10_000)) return undefined;
  return { report: { hostAccess: [], unsupported: [] }, imageReferences: named, references: { images: [...references.images], features: [...references.features] } };
}

/**
 * A ConfigCheckEntry, checked strictly and rebuilt: its four fields, the key and each job a sha256 in hex, the two
 * configurations plain JSON objects, at most MAX_CONFIG_CHECK_ANALYSES analyses that passed, the whole at most
 * MAX_CONFIG_CHECK_CHARACTERS; undefined for anything else. The extension checks each entry that the worker offers with
 * it, and each entry that it reads; the worker checks the answer of the extension with it.
 */
export function parseConfigCheckEntry(value: unknown): ConfigCheckEntry | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 4) return undefined;
  const { key, config, merged, analyses } = value;
  if (typeof key !== 'string' || !SHA256_HEX.test(key) || !isRecord(config) || !isRecord(merged)) return undefined;
  if (!Array.isArray(analyses) || analyses.length > MAX_CONFIG_CHECK_ANALYSES) return undefined;
  const checked: ConfigCheckEntry['analyses'] = [];
  for (const analysis of analyses) {
    if (!isRecord(analysis) || Object.keys(analysis).length !== 2 || typeof analysis.job !== 'string' || !SHA256_HEX.test(analysis.job)) return undefined;
    const result = passedAnalysis(analysis.result);
    if (result === undefined) return undefined;
    checked.push({ job: analysis.job, result });
  }
  let text: string;
  try {
    text = canonicalJson({ config, merged });
  } catch {
    return undefined;
  }
  if (text.length + JSON.stringify(checked).length > MAX_CONFIG_CHECK_CHARACTERS) return undefined;
  // Rebuilt from the JSON text: nothing of the sender's objects is kept.
  const copy = JSON.parse(JSON.stringify({ config, merged })) as { config: Record<string, unknown>; merged: Record<string, unknown> };
  return { key, config: copy.config, merged: copy.merged, analyses: checked };
}
