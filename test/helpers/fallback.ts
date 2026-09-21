/**
 * Test fixtures for Fallback chain progression specifications (Issue #7).
 *
 * The chain types themselves are not restated here: tests import `advanceChain` and
 * `AdvanceChainArgs` straight from `src/core/fallback.js` so tsc checks every call site
 * against the real signature.
 *
 * @module
 */

/**
 * Mock FallbackTimer Durable Object state for testing timer integration (#8).
 */
export interface MockFallbackTimerState {
  messageId: string;
  timeoutMs: number;
  createdAt: Date;
  triggered: boolean;
  input?: unknown;
}

/**
 * Mock FallbackTimer interface for testing timer re-arming and cancellation. Structurally a
 * {@link import('../../src/core/timer.js').FallbackTimerClient}, plus the call records the
 * assertions read.
 */
export interface MockFallbackTimer {
  stateMap: Map<string, MockFallbackTimerState>;
  cancelled: string[];
  rearmed: Array<{ messageId: string; timeoutMs: number }>;
  armed(messageId: string): MockFallbackTimerState | null;
  arm(messageId: string, timeoutMs: number, input?: unknown): void;
  cancel(messageId: string): void;
  isCancelled(messageId: string): boolean;
}

/**
 * Creates a mock FallbackTimer for testing fallback timer seams.
 *
 * @returns MockFallbackTimer instance.
 */
export function createMockFallbackTimer(): MockFallbackTimer {
  const stateMap = new Map<string, MockFallbackTimerState>();
  const cancelled: string[] = [];
  const rearmed: Array<{ messageId: string; timeoutMs: number }> = [];

  return {
    stateMap,
    cancelled,
    rearmed,
    armed(messageId: string): MockFallbackTimerState | null {
      return stateMap.get(messageId) ?? null;
    },
    arm(messageId: string, timeoutMs: number, input?: unknown): void {
      stateMap.set(messageId, {
        messageId,
        timeoutMs,
        createdAt: new Date(),
        triggered: false,
        input,
      });
      rearmed.push({ messageId, timeoutMs });
    },
    cancel(messageId: string): void {
      stateMap.delete(messageId);
      cancelled.push(messageId);
    },
    isCancelled(messageId: string): boolean {
      return cancelled.includes(messageId);
    },
  };
}
