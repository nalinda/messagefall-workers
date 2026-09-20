/**
 * Test helpers for Webhook dispatch specifications (Issue #5).
 *
 * The dispatch options, handler signature and StatusApplied event are imported
 * directly from src/core/webhook.js by the tests; only the ExecutionContext
 * double lives here.
 *
 * @module
 */

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
