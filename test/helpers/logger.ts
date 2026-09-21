/**
 * Type-level verification helpers for Issue #10 (No message bodies in logs).
 *
 * The logger and redaction APIs are imported directly from src/core/logger.js
 * and src/core/redact.js by the tests.
 *
 * @module
 */

import { describe, expect, it } from 'bun:test';

/**
 * Type-level verification helpers.
 */
export type Extends<A, B> = A extends B ? true : false;
export type Not<T extends boolean> = T extends true ? false : true;
export type Expect<T extends true> = T;
export type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/**
 * Type assertion helper for compile-time verification.
 */
export function assertType<T>(_value: T): void {
  // Compile-time type verification helper
}

/**
 * Self-test (see "Testing Guidelines" in `src/providers/README.md`): a helper file with
 * no `describe` of its own never shows up in the runner's output, which makes it look like a
 * red-phase test that silently failed to run. This runs with whichever spec imports the helper.
 */
describe('test/helpers/logger', () => {
  it('loads', () => {
    // The exports are types; `assertType` is the only value, and erasing the types would take
    // the type-level assertions in the logger specs with it.
    expect(typeof assertType).toBe('function');
    expect(assertType<number>(1)).toBeUndefined();
  });
});
