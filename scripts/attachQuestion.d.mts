// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/**
 * Makes the attach question of Dev Containers return true at once in every Dev Containers folder of the extensions
 * folder; a folder that an earlier call changed stays as it is. Throws when the question is not found in a folder, or
 * when no folder has Dev Containers. Returns a line for the log per Dev Containers folder.
 */
export function answerAttachQuestion(extensionsDir: string): string[];
