// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Whether a failure is one of the network, not of the thing asked for: the messages of Git (curl), Docker, BuildKit and
// Node.js (isNetworkFailure, for the texts of the flows), and an error of the Monitor's background run with its name,
// code and causes (isNetworkError). Pure; no I/O.

// Messages of Git (curl), Docker, BuildKit, and Node.js when the network or the name resolution fails.
const NETWORK_PATTERNS: readonly RegExp[] = [
  /could not resolve (host|proxy)/i,
  /failed to connect/i,
  /couldn't connect to server|could not connect to server/i,
  /connection (timed out|refused|reset)/i,
  /network is unreachable|no route to host/i,
  /temporary failure in name resolution/i,
  /name or service not known/i,
  /no such host/i,
  /\bdial tcp\b/i,
  /i\/o timeout/i,
  /tls handshake timeout/i,
  /operation timed out/i,
  /gnutls_handshake\(\) failed|ssl_error_syscall|ssl_connect/i,
  /getaddrinfo/i,
  /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b/,
];

/**
 * True if an error text describes a network failure, for example `fatal: unable to access '…': Could not resolve host`.
 * Git's "unable to access" counts only without an HTTP error status, because "returned error: 403" is an access problem.
 */
export function isNetworkFailure(text: string): boolean {
  if (NETWORK_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return /unable to access/i.test(text) && !/returned error:\s*\d{3}/i.test(text);
}

/** The codes of Node.js for a connection that could not be made, broke off, or got no answer in time. */
const NETWORK_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN', 'EPIPE']);

/**
 * More texts of a failure of the network than NETWORK_PATTERNS: the time limits of the daemon (a pull), of a proxy and
 * of the Monitor, and a server that answered 5xx or 429 (it is there, but not now).
 */
const MORE_NETWORK_TEXT = /\b(?:Client\.Timeout exceeded|context deadline exceeded|did not answer within|no answer in time|HTTP (?:5\d\d|429))\b/i;

/**
 * Whether `error` is a failure of the network, not of the thing asked for: an abort or a time limit, a code of
 * NETWORK_ERROR_CODES, or a message of isNetworkFailure or MORE_NETWORK_TEXT, also in its causes (at most 4 deep). A
 * refusal of a reachable server (404, 401, 403: an image or a version that is gone, a private image) is none.
 */
export function isNetworkError(error: unknown, depth = 0): boolean {
  if (typeof error === 'string') return isNetworkFailure(error) || MORE_NETWORK_TEXT.test(error);
  if (typeof error !== 'object' || error === null || depth > 4) return false;
  const { name, code, message, cause } = error as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;
  if (typeof message === 'string' && (isNetworkFailure(message) || MORE_NETWORK_TEXT.test(message))) return true;
  return cause !== undefined && isNetworkError(cause, depth + 1);
}

/**
 * Whether `error` is a failure that an answer of a server caused: its text says that the server answered (a refusal
 * such as `the update service answered HTTP 404`, or an answer that cannot be read), and it is no failure of the
 * network (isNetworkError: a 5xx is one). A failure without an answer (a TLS error of a captive portal, a proxy that
 * could not be read) is neither: it says nothing of the network.
 */
export function isServerAnswer(error: unknown): boolean {
  return error instanceof Error && /\banswered\b/i.test(error.message) && !isNetworkError(error);
}
