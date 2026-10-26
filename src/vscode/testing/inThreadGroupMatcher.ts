// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// A GroupMatcher for the tests: runs the match job on this thread, as the worker thread does (runMatchJob), and
// records each run.
import { runMatchJob, type GroupMatcher, type GroupMatchRun } from '../groupMatcher';

export interface InThreadGroupMatcher extends GroupMatcher {
  /** The runs: the value of the setting and the names of each. */
  runs: Array<{ entries: readonly unknown[]; names: string[] }>;
  /** When set, the next runs give this result instead of running the job. */
  result?: GroupMatchRun;
}

export function inThreadGroupMatcher(): InThreadGroupMatcher {
  const matcher: InThreadGroupMatcher = {
    runs: [],
    async run(entries, names) {
      matcher.runs.push({ entries, names: [...names] });
      if (matcher.result) return matcher.result;
      let result: GroupMatchRun = { failed: true };
      runMatchJob({ kind: 'match', id: 1, entries, names }, (message) => {
        if (message.type === 'places') result = { places: new Map(message.places), failures: new Map(message.failures) };
      });
      return result;
    },
    dispose() {},
  };
  return matcher;
}
