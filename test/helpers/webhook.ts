/**
 * Test helpers for Webhook dispatch specifications (Issue #5).
 *
 * The dispatch options, handler signature and StatusApplied event are imported
 * directly from src/core/webhook.js by the tests; only the ExecutionContext
 * double lives here.
 *
 * @module
 */

import { describe, expect, it } from 'bun:test';

/**
 * Mock ExecutionContext for verifying ctx.waitUntil usage.
 */
export interface MockExecutionContext {
  waitUntil: (promise: Promise<unknown>) => void;
  passThroughOnException: () => void;
  promises: Promise<unknown>[];
  flush: () => Promise<void>;
}

/**
 * Creates a mock ExecutionContext for testing ctx.waitUntil.
 */
export function createMockExecutionContext(): MockExecutionContext {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    waitUntil(promise: Promise<unknown>): void {
      promises.push(promise);
    },
    passThroughOnException(): void {
      // no-op
    },
    async flush(): Promise<void> {
      await Promise.all(promises);
    },
  };
}

/**
 * Self-test (AGENTS.md, "Shared test fixtures/helpers under `test/helpers/`"): a helper file with
 * no `describe` of its own never shows up in the runner's output, which makes it look like a
 * red-phase test that silently failed to run. This runs with whichever spec imports the helper.
 */
describe('test/helpers/webhook', () => {
  it('loads', () => {
    const ctx = createMockExecutionContext();
    expect(ctx.promises).toEqual([]);
    ctx.waitUntil(Promise.resolve());
    expect(ctx.promises).toHaveLength(1);
  });
});
