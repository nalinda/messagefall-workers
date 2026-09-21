/**
 * Small, side-effect-free helpers shared by HTTP-backed providers.
 *
 * Kept tiny and dependency-free so each provider entry point stays
 * independently tree-shakeable.
 *
 * @module
 */

/**
 * Maximum number of response-body characters carried in an error message.
 */
const ERROR_SNIPPET_LENGTH = 200;

/**
 * Whether an HTTP status is worth retrying on the same channel:
 * 429 (rate limited) or any 5xx.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Format `"<status> <snippet>"` from an HTTP status and response text,
 * truncating the text so error strings stay bounded; `"<status>"` alone
 * when the body is empty.
 */
export function formatHttpError(status: number, responseText: string): string {
  const snippet = responseText.slice(0, ERROR_SNIPPET_LENGTH);
  return snippet.length > 0 ? `${status} ${snippet}` : String(status);
}

/**
 * Parses a response body as JSON, returning `undefined` for an empty body or one that fails to
 * parse — a vendor error page or a truncated body must not throw, only leave the caller without
 * a structured error to read fields off of.
 */
export function parseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
