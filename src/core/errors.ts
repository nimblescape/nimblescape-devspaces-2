// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Errors with a plain-language message for the user. Technical details go to the log.

export const USER_ERROR_CODES = [
  'dockerNotInstalled',
  'dockerStartFailed',
  'dockerEngineNotRunning',
  'helperFailed',
  'cloneFailed',
  'firstOpenOffline',
  'noConfiguration',
  'buildFailed',
  'startFailed',
  'filesMissing',
  'signInRequired',
  'hostAccess',
  'otherAccount',
  'dockerHostUnreachable',
  'dockerEndpointUnsupported',
  'otherDockerHost',
  'sessionMonitorFailed',
  /** The record of the devspace holds a value that the worker refuses; no retry helps. */
  'recordInvalid',
  'cancelled',
] as const;

/**
 * The kinds of a UserFacingError, also as a list (USER_ERROR_CODES), so that a refusal that the worker answers is
 * checked against it.
 */
export type UserErrorCode = (typeof USER_ERROR_CODES)[number];

/** True for a kind of UserFacingError. */
export function isUserErrorCode(value: unknown): value is UserErrorCode {
  return typeof value === 'string' && (USER_ERROR_CODES as readonly string[]).includes(value);
}

export class UserFacingError extends Error {
  constructor(
    readonly code: UserErrorCode,
    message: string,
    /** Technical details for the log. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'UserFacingError';
  }
}

export function isUserFacingError(error: unknown): error is UserFacingError {
  return error instanceof UserFacingError;
}

/**
 * The refusal of the batch scope of an open (src/core/helper/batchScope.ts: a session that cannot be opened, a lost
 * lock, a step without a batch kind, …), with Messages.batchHelperUnavailable: a helper that cannot be opened is an
 * inconsistent state, so the operation is refused. Its code is `helperFailed`, so that every rule of a failed helper
 * applies to it (a helperFailed in Step 8 fails the open, the container of a failed `up` is withdrawn); but it is told
 * apart from a helperFailed of the helper image (isBatchHelperUnavailable): the rule under which a running, current
 * container opens as it is when the helper cannot be prepared at the start does not apply to it. Start and Rebuild
 * are refused.
 */
export class BatchHelperUnavailableError extends UserFacingError {
  readonly batchHelperUnavailable = true;
  constructor(message: string, detail?: string) {
    super('helperFailed', message, detail);
  }
}

/** Whether `error` is the refusal of the batch scope (BatchHelperUnavailableError). */
export function isBatchHelperUnavailable(error: unknown): error is BatchHelperUnavailableError {
  return error instanceof BatchHelperUnavailableError;
}

/**
 * The Monitor container of the engine could not be ensured at an open (Messages.sessionMonitorUnavailable). The
 * open is refused; no rule that opens a devspace as it is applies.
 */
export function isSessionMonitorFailed(error: unknown): error is UserFacingError {
  return isUserFacingError(error) && error.code === 'sessionMonitorFailed';
}

/** A command that ended with a non-zero exit code. */
export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${command} failed with exit code ${exitCode}: ${(stderr || stdout).trim().slice(-2000)}`);
    this.name = 'CommandError';
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
