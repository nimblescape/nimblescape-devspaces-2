// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The collector of a batch step (collectBatchStep) and OutputTail, which the worker's own batch session uses
// (src/helperChannel/batch.ts). The step is a fake `run` of collectBatchStep.
import { describe, expect, it } from 'vitest';
import { MAX_CAPTURED_STDERR_CHARACTERS } from '../helper/analysisLimits';
import { OutputTooLargeError } from '../process';
import { HelperOperationError, OutputTail, collectBatchStep, type BatchStepOptions } from './helperChannel';

const TOKEN = 'ghp_client_side_token_value';

/** A step whose output and result the test gives: `out` passes a piece, `end` settles the run. */
function step(options: BatchStepOptions = {}, maxStdoutBytes = 64 * 1024 * 1024) {
  let onOutput!: (stream: 'stdout' | 'stderr', piece: string) => void;
  let signal!: AbortSignal;
  let settle!: { resolve(value: unknown): void; reject(error: unknown): void };
  const running = collectBatchStep('listConfigs', options, maxStdoutBytes, (stepSignal, output) => {
    signal = stepSignal;
    onOutput = output;
    return new Promise((resolve, reject) => (settle = { resolve, reject }));
  });
  return {
    running,
    signal: () => signal,
    out: (stream: 'stdout' | 'stderr', piece: string) => onOutput(stream, piece),
    end: (value: unknown) => settle.resolve(value),
    fail: (error: unknown) => settle.reject(error),
  };
}

describe('collectBatchStep', () => {
  it('masks the secret in the output of a step itself, also across pieces', async () => {
    const seen: string[] = [];
    const s = step({ secrets: { token: TOKEN }, onOutput: (_stream, text) => seen.push(text) });
    s.out('stdout', `a ${TOKEN.slice(0, 7)}`);
    s.out('stdout', `${TOKEN.slice(7)} b`);
    s.out('stderr', TOKEN);
    s.end({ exitCode: 0 });
    expect(await s.running).toEqual({ exitCode: 0, stdout: 'a *** b', stderr: '***', timedOut: false });
    expect(seen.join('')).not.toContain(TOKEN);
  });

  it('maps the time limit of a step to timedOut', async () => {
    const s = step({ timeoutMs: 1_000 });
    s.fail(new HelperOperationError('timeout', 'x', false));
    expect(await s.running).toMatchObject({ exitCode: null, timedOut: true });
  });

  it('stdout beyond the cap cancels the step and rejects with OutputTooLargeError', async () => {
    const s = step({}, 1_000);
    s.out('stdout', 'x'.repeat(600));
    s.out('stdout', 'x'.repeat(600));
    expect(s.signal().aborted).toBe(true);
    s.fail(new HelperOperationError('cancelled', 'x', false, true));
    expect(await s.running.catch((caught: unknown) => caught)).toBeInstanceOf(OutputTooLargeError);
  });

  it('with a caller signal, stdout beyond the cap still cancels the step and the step rejects with OutputTooLargeError', async () => {
    const caller = new AbortController();
    const s = step({ signal: caller.signal }, 1_000);
    s.out('stdout', 'x'.repeat(600));
    s.out('stdout', 'x'.repeat(600));
    // The cap aborts the step also when the caller passed its own signal (AbortSignal.any).
    expect(s.signal().aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    // A result after the cancel still rejects.
    s.end({ exitCode: 0 });
    expect(await s.running.catch((caught: unknown) => caught)).toBeInstanceOf(OutputTooLargeError);
  });

  it('an overflow that only the flush after a success finds (a held-back tail that could start the secret) rejects with OutputTooLargeError', async () => {
    const s = step({ secrets: { token: TOKEN } }, 1_000);
    // 999 characters pass; the masker holds back 'ghp_cl' (it could start the token), so no cancel yet.
    s.out('stdout', 'x'.repeat(999) + TOKEN.slice(0, 6));
    expect(s.signal().aborted).toBe(false);
    s.end({ exitCode: 0 });
    // Not { exitCode: 0, stdout: '' }: the output is never lost without a word.
    expect(await s.running.catch((caught: unknown) => caught)).toBeInstanceOf(OutputTooLargeError);
  });

  it('the stderr of a step keeps its end, at most MAX_CAPTURED_STDERR_CHARACTERS', async () => {
    const s = step();
    const piece = 64 * 1024;
    for (let sent = 0; sent < 3 * MAX_CAPTURED_STDERR_CHARACTERS; sent += piece) s.out('stderr', 'e'.repeat(piece));
    s.out('stderr', 'the end');
    s.end({ exitCode: 0 });
    const result = await s.running;
    expect(result.stderr).toHaveLength(MAX_CAPTURED_STDERR_CHARACTERS);
    expect(result.stderr.endsWith('ethe end')).toBe(true);
  });

  it('OutputTail holds at most twice its cap while it grows, and gives its end', () => {
    const tail = new OutputTail(10);
    let most = 0;
    for (let i = 0; i < 100; i++) {
      tail.push(String(i % 10));
      most = Math.max(most, tail.held);
    }
    tail.push('x'.repeat(25));
    most = Math.max(most, tail.held);
    expect(most).toBeLessThanOrEqual(20);
    tail.push('0123456789abc');
    expect(tail.text).toBe('3456789abc');
    expect(tail.held).toBe(10);
  });

  it('the end of the stdout of a masked step that could start the secret is kept', async () => {
    const s = step({ secrets: { token: TOKEN } });
    // TOKEN starts with `g`: the redactor holds the last `g` back until the end.
    s.out('stdout', 'building');
    s.end({ exitCode: 0 });
    expect(await s.running).toEqual({ exitCode: 0, stdout: 'building', stderr: '', timedOut: false });
  });
});
