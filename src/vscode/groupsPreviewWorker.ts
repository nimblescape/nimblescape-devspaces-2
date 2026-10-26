// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Worker thread of the repository groups (bundle dist/groupsPreviewWorker.js): runs the regular expressions of the
// setting `repositoryGroups` for the sidebar (match jobs, groupMatcher.ts), and of the draft of the editor for the
// preview and the test field (groupsPreviewRunner.ts), so a slow one cannot stop the extension host. The runners stop
// the worker after their time limit. No `vscode` import.
import { parentPort } from 'worker_threads';
import { runMatchJob, type GroupMatchJob } from './groupMatcher';
import { runPreviewJob, type PreviewJob } from './repositoryGroupsEditorModel';

parentPort?.on('message', (job: PreviewJob | GroupMatchJob) => {
  const post = (message: unknown) => parentPort?.postMessage(message);
  if ('kind' in job && job.kind === 'match') runMatchJob(job, post);
  else runPreviewJob(job as PreviewJob, post);
});
