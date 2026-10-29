// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The SSH logins on the other computer of the run `remote` (prepare.ts), from the log of its container: sshd logs each
// login (LogLevel VERBOSE), and the ForceCommand of each session writes its command first (`devspaces-test-ssh:
// <command>`). `docker logs --timestamps` puts the time of each line in front of it. No `vscode`, so that the parsing
// runs without VS Code too.

/** The start of the line that the ForceCommand of the other computer writes for each session (prepare.ts). */
export const SESSION_LINE_START = 'devspaces-test-ssh: ';

/** A login of sshd, or the command of a session, at its time in milliseconds since 1970. */
export interface SshLogEvent {
  time: number;
  kind: 'login' | 'session';
  /** The line of sshd for a login; the command (`(shell)` without one) for a session. */
  text: string;
}

/**
 * The time of a timestamp of `docker logs --timestamps` in milliseconds since 1970: RFC 3339 in UTC with up to nine
 * digits of the second, which Docker shortens by the zeros at their end. Undefined for another text.
 */
export function logTime(stamp: string): number | undefined {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(stamp);
  if (!match) return undefined;
  const seconds = Date.parse(`${match[1]}Z`);
  if (Number.isNaN(seconds)) return undefined;
  return seconds + Number((match[2] ?? '').padEnd(3, '0').slice(0, 3));
}

/**
 * The logins (`Accepted <method> for <user> from <address> port <port>`) and the session commands in the output of
 * `docker logs --timestamps`, ordered by their time (lines of the same time keep their order). Other lines are left out.
 */
export function sshLogEvents(output: string): SshLogEvent[] {
  const events: SshLogEvent[] = [];
  for (const line of output.split(/\r?\n/)) {
    const space = line.indexOf(' ');
    const time = space > 0 ? logTime(line.slice(0, space)) : undefined;
    if (time === undefined) continue;
    const text = line.slice(space + 1).trimEnd();
    if (text.startsWith(SESSION_LINE_START)) events.push({ time, kind: 'session', text: text.slice(SESSION_LINE_START.length) });
    else if (/\bAccepted \S+ for \S+ from \S+ port \d+/.test(text)) events.push({ time, kind: 'login', text });
  }
  return events.sort((a, b) => a.time - b.time);
}

/** The number of logins in `events` up to and including `until` (all without it). */
export function loginsUntil(events: readonly SshLogEvent[], until = Number.POSITIVE_INFINITY): number {
  return events.filter((event) => event.kind === 'login' && event.time <= until).length;
}
