// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Interfaces through which code in src/core receives what it needs. Code in src/core never imports `vscode`.
import type { DeleteConfirmation } from './pipeline/deleteCheck';
import type { ProgressStep } from './messages';
import type { GitHubAccount } from './types';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
  /** Raw output of a tool (Docker, the Dev Container CLI, Git). Appended as it is. */
  output(text: string): void;
}

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  output() {},
};

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function isoTime(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}

/** Waits `ms` milliseconds. Rejects with an `AbortError` when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(): Error {
  const error = new Error('The operation was cancelled.');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * `run` within `ms`, the one time-limited call of the worker (EngineDocker's calls, the engine of the Monitor's
 * ensure, the stops of Stop). `run` gets a signal that aborts at `signal` or
 * after `ms`. When the time limit ended it and `signal` did not abort, it rejects with the error of `timedOut`, whatever
 * `run` rejected with; any other failure, and a cancel of `signal`, passes unchanged.
 */
export async function withTimeLimit<T>(ms: number, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>, timedOut: () => Error): Promise<T> {
  const limit = AbortSignal.timeout(ms);
  try {
    return await run(signal ? AbortSignal.any([signal, limit]) : limit);
  } catch (error) {
    if (limit.aborted && !signal?.aborted) throw timedOut();
    throw error;
  }
}

export interface RunOptions {
  /** Complete environment of the process. Default: the environment of this process. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Written to standard input, then standard input is closed. Without it, standard input is closed at once. */
  input?: string;
  /** The process is killed after this time. */
  timeoutMs?: number;
  /** The process is killed when the signal aborts, and `run` rejects with an `AbortError`. */
  signal?: AbortSignal;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export interface RunResult {
  /** `null` when the process ended through a signal (for example after a timeout). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a program without a shell. `run` resolves also for a non-zero exit code.
 * It rejects when the program cannot be started (the error has `code === 'ENOENT'` if it does not exist),
 * and with an `AbortError` when the signal aborts.
 */
export interface ProcessRunner {
  run(file: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
  /**
   * The helper channel: starts a program whose standard input stays open until `end`. Never
   * throws; a program that cannot be started resolves `exited` with `error`.
   */
  start?(file: string, args: readonly string[], options?: StartOptions): StartedProcess;
}

export interface StartOptions {
  /** Complete environment of the process. Default: the environment of this process. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** A program started with ProcessRunner.start. */
export interface StartedProcess {
  /** Writes to its standard input. False when that is closed. */
  write(text: string): boolean;
  /** Closes its standard input. */
  end(): void;
  /** Stops it (on Windows with the processes that it started). */
  kill(): void;
  /**
   * Stops it and the programs that it started at once, synchronously (SIGKILL; for the end of the extension host, where
   * no timer runs anymore).
   */
  killNow?(): void;
  /** Its process id, when it started (for the tests that break a connection hard). */
  readonly pid?: number;
  /** Its output, decoded as UTF-8, as it comes. One listener each. */
  onStdout(listener: (text: string) => void): void;
  onStderr(listener: (text: string) => void): void;
  /** Resolves when it ended: its exit code (null after a signal), or the error of its start. */
  readonly exited: Promise<{ exitCode: number | null; error?: Error }>;
}

/** Progress of one operation, shown in one notification. */
export interface ProgressReporter {
  /** Starts a step. Steps that are not needed are not reported. */
  step(step: ProgressStep): void;
  /** Additional text for the current step, for example the reason for an update. */
  detail(message: string): void;
}

export const silentProgress: ProgressReporter = { step() {}, detail() {} };

export interface Credentials {
  username: string;
  password: string;
}

/** Access to the GitHub session of VS Code. */
export interface GitHubAuth {
  /** Token of the session with the scopes `repo` and `read:org`. `interactive: false` never shows a dialog. */
  getToken(options: { interactive: boolean }): Promise<string | undefined>;
  /**
   * The account of the same session as getToken: the GitHub user ID and the login. `undefined` when no session exists
   * (not signed in). `interactive: false` never shows a dialog.
   */
  getAccount(options: { interactive: boolean }): Promise<GitHubAccount | undefined>;
  /** Credentials for ghcr.io from the session with the additional scope `read:packages`. */
  getPackagesCredentials(options: { interactive: boolean }): Promise<Credentials | undefined>;
  /**
   * GitHub rejected `token` (HTTP 401, or Git "Authentication failed" for github.com). Every caller of GitHub reports it
   * here, so that the session does not count as signed in and the next sign-in replaces it. Never throws.
   */
  reportRejectedToken?(token: string): void;
}

/**
 * What the question configurationChanged names (ConfigurationChangeKind): `defaultImage`, the default image of a
 * default-image devspace changed (the setting); none, the configuration of the devspace changed.
 */
export type ConfigurationChangeKind = 'defaultImage';

/** Decisions and messages that the open pipeline needs from the user interface. */
export interface PipelineUi {
  /** Security: first open of a repository of another owner. */
  confirmUntrustedRepository(repository: string): Promise<boolean>;
  /**
   * The devcontainer.json changed since the last build; `what` (ConfigurationChangeKind) names a changed default image
   * (the message names it).
   */
  configurationChanged(repository: string, what?: ConfigurationChangeKind): Promise<'rebuildNow' | 'later'>;
  /**
   * The containers of a devspace without a build record are of another kind (Docker Compose or a single container)
   * than its configuration. `message`: Messages.configurationKindChanged. `later` keeps the kind.
   */
  configurationKindChanged(repository: string, message: string): Promise<'rebuildNow' | 'later'>;
  /** The workspace volume is missing. `undefined` means cancel. */
  filesMissing(repository: string): Promise<'cloneAgain' | 'deleteDevspace' | undefined>;
  /**
   * Recreate offer: the existing container of the devspace is damaged, so that it cannot be
   * started or used. `question`: Messages.containerRecreateQuestion and containerRecreateDetail (what is kept and what is
   * lost). `true` only when the user chooses Recreate; a dismissed question changes nothing.
   */
  recreateContainer(repository: string, question: { message: string; detail: string }): Promise<boolean>;
  /**
   * A newer image is available for the existing container of the devspace (`running`: it
   * runs). The window words it after the setting updateContainer: `notify` gives `update` (Continue) or `cancel`
   * (Cancel, or a dismissed message: the open ends, nothing is changed and the window is not connected); `ask` gives
   * `update` (Update Now) or `later` (Later, or a dismissed question: the existing container starts and the window
   * connects without the update).
   */
  updateContainer(repository: string, running: boolean): Promise<'update' | 'later' | 'cancel'>;
  /**
   * The confirmation of Delete with its facts (DeleteConfirmation of deleteCheck.ts, which the extension words).
   * `open`: Open devspace (offered with changes); `undefined`: cancel.
   */
  confirmDelete(repository: string, confirmation: DeleteConfirmation): Promise<'delete' | 'open' | undefined>;
  /** The additional volumes that Delete may remove too (Remove or Keep); `undefined`: cancel. */
  deleteAdditionalVolumes(volumes: readonly string[]): Promise<'remove' | 'keep' | undefined>;
  /**
   * The volumes with the data of services, none ticked; the ticked ones are removed; `possibly`: those that may hold
   * data of services. `undefined`: cancel.
   */
  deleteServiceData(volumes: readonly string[], possibly: readonly string[]): Promise<string[] | undefined>;
  /** Non-blocking information message. */
  info(message: string): void;
  /** Non-blocking warning message. */
  warn(message: string): void;
  /** Non-blocking message "The registry … requires a sign-in." with the action Sign in (only for ghcr.io). */
  registrySignIn(registry: string): void;
}
