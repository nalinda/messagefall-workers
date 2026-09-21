/**
 * The two one-liners every entry point needs when it looks at a value it did not create: a
 * parsed JSON body, a caller's options object, a thrown `unknown`.
 *
 * They were written out again in `src/env.ts`, `src/app/hono.ts`, `src/client/index.ts` and
 * `src/core/send.ts`, which is exactly the drift `normalizeBasePath` was extracted to
 * `./base-path.js` to avoid. Like that module this one imports nothing, so the client entry
 * point can use it without pulling in the rest of the core.
 *
 * @module
 */

/**
 * Whether `value` is a non-null object, so its properties can be read.
 *
 * Deliberately true for arrays and class instances too: every caller here is asking "can I index
 * this?", not "is this a plain object".
 *
 * @param value - The value to narrow.
 * @returns True when the value is a non-null object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The message of a thrown value, whatever was thrown.
 *
 * @param error - The caught value.
 * @returns Its `message` when it is an `Error`, its string form otherwise.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
