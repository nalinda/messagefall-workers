/**
 * Test helpers and type definitions for Fallback chain progression specifications (Issue #7).
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import type { StatusStore } from '../../src/core/status.js';
import type { Provider } from '../../src/providers/types.js';
import type { MessagingConfig, MessagingEnv, TemplateDef } from '../../src/types.js';

/**
 * Arguments for advancing the delivery fallback chain.
 */
export interface AdvanceChainArgs<Env = MessagingEnv> {
  /**
   * Internal message identifier.
   */
  id: string;
  /**
   * Reason for advancing the chain: delivery status failed or timer timed out.
   */
  reason: 'failed' | 'timeout';
  /**
   * Cloudflare Workers environment bindings (e.g. MESSAGES_KV, FALLBACK_TIMER).
   */
  env: Env;
  /**
   * Messaging configuration options containing templates, providers, onStatus, etc.
   */
  options: MessagingConfig<Env> & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    templates?: Record<string, TemplateDef<any>>;
    providers?: Record<string, Provider> | Provider[] | Map<string, Provider>;
    onStatus?: (event: unknown) => void | Promise<void>;
    fallbackTimeoutMs?: number;
    kv?: KVNamespace;
  };
  /**
   * Status store for reading and updating delivery status records.
   */
  store: StatusStore;
  /**
   * Optional synchronous input pass-through from send pipeline (#3).
   */
  input?: unknown;
}

/**
 * Signature of the advanceChain function.
 */
export type AdvanceChainFn = (args: AdvanceChainArgs) => Promise<void>;

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
 * Mock FallbackTimer interface for testing timer re-arming and cancellation.
 */
export interface MockFallbackTimer {
  stateMap: Map<string, MockFallbackTimerState>;
  cancelled: string[];
  rearmed: Array<{ messageId: string; timeoutMs: number }>;
  getState(messageId: string): MockFallbackTimerState | null;
  setState(messageId: string, timeoutMs: number, input?: unknown): void;
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
    getState(messageId: string): MockFallbackTimerState | null {
      return stateMap.get(messageId) ?? null;
    },
    setState(messageId: string, timeoutMs: number, input?: unknown): void {
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

/**
 * Dynamically loads advanceChain from src/core/fallback.js if implemented,
 * or returns a dummy stub in the RED phase so tests execute assertions
 * and fail on expectation assertions, not missing module imports.
 *
 * @returns AdvanceChainFn implementation or no-op stub.
 */
export async function loadAdvanceChain(): Promise<AdvanceChainFn> {
  try {
    const fallbackEntry = '../../src/core/fallback.js';
    const mod = (await import(fallbackEntry)) as unknown as {
      advanceChain?: AdvanceChainFn;
    };
    if (typeof mod.advanceChain === 'function') {
      return mod.advanceChain;
    }
  } catch {
    // fallback.js not yet implemented (RED phase)
  }

  try {
    const rootEntry = '../../src/index.js';
    const root = (await import(rootEntry)) as unknown as {
      advanceChain?: AdvanceChainFn;
    };
    if (typeof root.advanceChain === 'function') {
      return root.advanceChain;
    }
  } catch {
    // index.js does not export advanceChain yet
  }

  // Return a dummy function so tests execute real assertions and fail for the right reason
  return async (_args: AdvanceChainArgs): Promise<void> => {
    // No-op in RED phase
  };
}
