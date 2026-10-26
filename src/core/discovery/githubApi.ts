// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// GitHub GraphQL API over an HttpTransport. The token is used only for the Authorization header: it never appears in a
// log line or in an error message.
import { userAgent, type HttpResponse, type HttpTransport } from '../http';
import { abortError, isAbortError, silentLogger, systemClock, type Clock, type Logger } from '../ports';
import { isRecord } from '../valueChecks';

export const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';
/** Time limit of one request. The HttpTransport has no time limit of its own. */
export const DEFAULT_GITHUB_TIMEOUT_MS = 30_000;

/** One entry of the `errors` array of a GraphQL response. */
export interface GraphQLError {
  message: string;
  /** GitHub sets it for some errors, for example `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`. */
  type?: string;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
}

/** The API answered with an HTTP status other than 200. A 401 means that the session is not valid anymore. */
export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

/**
 * GitHub refused the request for its rate limit: an answer with an error of the type RATE_LIMITED (the GraphQL API
 * answers a primary rate limit with HTTP 200), or HTTP 429, or HTTP 403 for a rate limit (a secondary rate limit).
 * `resetAt`: the time (ms since 1970) from which GitHub takes requests again, when the answer names it (rateLimitResetAt).
 */
export class GitHubRateLimitError extends GitHubApiError {
  constructor(
    message: string,
    status: number,
    readonly resetAt: number | undefined,
  ) {
    super(message, status);
    this.name = 'GitHubRateLimitError';
  }
}

/** GitHub did not answer within the time limit of the request. */
export class GitHubTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`GitHub did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
    this.name = 'GitHubTimeoutError';
  }
}

export interface GitHubApiOptions {
  /** Time limit of one request. Default: 30 seconds. */
  timeoutMs?: number;
  /** GitHub answered HTTP 401 for `token` (the sign-in is not valid anymore). Called before the error is thrown. */
  onUnauthorized?: (token: string) => void;
  /** GitHub answered HTTP 200 for `token`. */
  onAuthorized?: (token: string) => void;
  /** For the time of a rate limit that GitHub names in seconds from now (`retry-after`). */
  clock?: Clock;
}

export class GitHubApi {
  private readonly timeoutMs: number;
  private readonly onUnauthorized: ((token: string) => void) | undefined;
  private readonly onAuthorized: ((token: string) => void) | undefined;
  private readonly clock: Clock;

  constructor(
    private readonly transport: HttpTransport,
    private readonly logger: Logger = silentLogger,
    options: GitHubApiOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS;
    this.onUnauthorized = options.onUnauthorized;
    this.onAuthorized = options.onAuthorized;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Runs a GraphQL query. Resolves with `data` and `errors` of the response: GitHub can return partial data together
   * with errors, for example for organizations with SAML single sign-on.
   * Throws `GitHubApiError` for an HTTP status other than 200 or a response that is not GraphQL,
   * `GitHubRateLimitError` (a GitHubApiError) for a rate limit, `GitHubTimeoutError` after the time limit, an
   * `AbortError` when the signal aborts, and the error of the transport when the connection fails.
   */
  async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    token: string,
    signal?: AbortSignal,
  ): Promise<{ data?: T; errors?: GraphQLError[] }> {
    const response = await this.post(JSON.stringify({ query, variables }), token, signal);
    // Every GraphQL request of the extension goes through here, so every 401 reaches the one place of the sign-in state.
    if (response.status === 401) this.notify(this.onUnauthorized, token);
    if (response.status === 200) this.notify(this.onAuthorized, token);
    if (response.status !== 200) {
      const message = `GitHub API request failed with HTTP status ${response.status}${describeBody(response.body)}.`;
      if (isRateLimitStatus(response)) {
        throw new GitHubRateLimitError(message, response.status, rateLimitResetAt(response.headers, this.clock.now()));
      }
      throw new GitHubApiError(message, response.status);
    }
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      this.logger.warn(`GitHub API: the response is not valid JSON (${response.body.length} characters).`);
      throw new GitHubApiError('GitHub API returned a response that is not valid JSON.', response.status);
    }
    if (!isRecord(body)) {
      throw new GitHubApiError('GitHub API returned an unexpected response.', response.status);
    }
    const result: { data?: T; errors?: GraphQLError[] } = {};
    if (isRecord(body.data)) result.data = body.data as T;
    const errors = normalizeErrors(body.errors);
    // A rate limit refuses the whole query: no request gets an answer before its reset.
    if (errors.some(isRateLimitError)) {
      throw new GitHubRateLimitError(
        `GitHub refused the request for its rate limit: ${describeGraphQLErrors(errors)}`,
        response.status,
        rateLimitResetAt(response.headers, this.clock.now()),
      );
    }
    if (errors.length > 0) result.errors = errors;
    if (result.data === undefined && result.errors === undefined) {
      throw new GitHubApiError('GitHub API returned a response without data and without errors.', response.status);
    }
    return result;
  }

  private notify(listener: ((token: string) => void) | undefined, token: string): void {
    try {
      listener?.(token);
    } catch (error) {
      this.logger.warn(`GitHub API: the sign-in state could not be updated: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async post(body: string, token: string, signal?: AbortSignal): Promise<HttpResponse> {
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.transport.request(
        {
          method: 'POST',
          url: GITHUB_GRAPHQL_URL,
          headers: {
            Authorization: `bearer ${token}`,
            'User-Agent': userAgent(),
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Content-Length': String(Buffer.byteLength(body, 'utf8')),
          },
          body,
        },
        controller.signal,
      );
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (timedOut) throw new GitHubTimeoutError(this.timeoutMs);
      // The transport error of a failed connection does not contain the headers, so it cannot contain the token.
      if (isAbortError(error)) throw abortError();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** Keeps only well-formed error entries. An entry without a message gets a generic one. */
function normalizeErrors(value: unknown): GraphQLError[] {
  if (!Array.isArray(value)) return [];
  const errors: GraphQLError[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const error: GraphQLError = {
      message: typeof entry.message === 'string' ? entry.message : 'Unknown GraphQL error.',
    };
    if (typeof entry.type === 'string') error.type = entry.type;
    if (Array.isArray(entry.path)) {
      error.path = entry.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number');
    }
    if (isRecord(entry.extensions)) error.extensions = entry.extensions;
    errors.push(error);
  }
  return errors;
}

/** An error of the GraphQL API for a rate limit: of the type RATE_LIMITED, or a message about a secondary rate limit. */
function isRateLimitError(error: GraphQLError): boolean {
  return error.type === 'RATE_LIMITED' || /\brate limit\b/i.test(error.message);
}

/**
 * An HTTP status of a rate limit: 429, or 403 with no request left (`x-ratelimit-remaining: 0`), a time to wait
 * (`retry-after`), or a message about a rate limit (a secondary rate limit). Another 403 is no rate limit (for example
 * an organization that restricts the access).
 */
function isRateLimitStatus(response: HttpResponse): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return response.headers['x-ratelimit-remaining'] === '0' || response.headers['retry-after'] !== undefined || /\brate limit\b/i.test(response.body);
}

/**
 * The time (ms since 1970) from which GitHub takes requests again after a rate limit, from the headers of its answer:
 * `retry-after` (seconds from `now`), else `x-ratelimit-reset` (seconds since 1970) while `x-ratelimit-remaining` is 0.
 * `undefined` when the answer names no time.
 */
function rateLimitResetAt(headers: Record<string, string>, now: number): number | undefined {
  const retryAfter = Number(headers['retry-after'] ?? Number.NaN);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return now + retryAfter * 1000;
  const reset = Number(headers['x-ratelimit-reset'] ?? Number.NaN);
  if (headers['x-ratelimit-remaining'] === '0' && Number.isFinite(reset) && reset > 0) return reset * 1000;
  return undefined;
}

/** `: <message>` from a JSON error body of GitHub, for example `{"message":"Bad credentials"}`. */
function describeBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && typeof parsed.message === 'string' && parsed.message.trim() !== '') {
      return `: ${parsed.message.trim().slice(0, 500)}`;
    }
  } catch {
    // Not JSON, for example an HTML page of a proxy.
  }
  return '';
}

/** Short text of GraphQL errors for a log line or an error message. Identical messages are listed once. */
export function describeGraphQLErrors(errors: readonly GraphQLError[] | undefined): string {
  if (!errors || errors.length === 0) return 'no details';
  const messages = [...new Set(errors.map((error) => (error.type ? `${error.type}: ${error.message}` : error.message)))];
  const shown = messages.slice(0, 5).join(' | ');
  return messages.length > 5 ? `${shown} | … (${messages.length - 5} more)` : shown;
}
