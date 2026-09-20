/**
 * FallbackTimer
 *
 * Durable Object for timed fallback when no delivery status arrives.
 *
 * @module
 */

import type { DurableObjectSlot } from '@cloudflare/workers-types';

/**
 * Fallback timer state.
 */
interface FallbackTimerState {
  /**
   * Message ID this timer is for.
   */
  messageId: string;
  /**
   * Timeout threshold in ms.
   */
  timeoutMs: number;
  /**
   * Timestamp when timer was set.
   */
  createdAt: Date;
  /**
   * Whether fallback has already been triggered.
   */
  triggered: boolean;
}

/**
 * FallbackTimer Durable Object interface.
 */
export interface FallbackTimer {
  /**
   * Get the timer state.
   */
  getState(messageId: string): FallbackTimerState | null;
  /**
   * Set the timer state.
   */
  setState(messageId: string, timeoutMs: number): void;
  /**
   * Mark timer as triggered (fallback already applied).
   */
  trigger(messageId: string): void;
  /**
   * Check if timeout has been reached.
   */
  isTimeout(messageId: string): boolean;
}

/**
 * FallbackTimer Durable Object spec.
 */
export class FallbackTimer {
  private readonly state: Map<string, FallbackTimerState>;
  private readonly timeoutMs: number;

  constructor(ctx: DurableObjectSlot) {
    this.timeoutMs = ctx.env.FALLBACK_TIMEOUT_MS ?? 5000;
    this.state = ctx.state;
  }

  /**
   * Get or create a timer state for the message ID.
   */
  getState(messageId: string): FallbackTimerState | null {
    return this.state.get(messageId) ?? null;
  }

  /**
   * Set a new timer state for the message ID.
   */
  setState(messageId: string, timeoutMs?: number): void {
    this.state.set(messageId, {
      messageId,
      timeoutMs: timeoutMs ?? this.timeoutMs,
      createdAt: new Date(),
      triggered: false,
    });
  }

  /**
   * Mark timer as triggered (fallback already applied).
   */
  trigger(messageId: string): void {
    const timer = this.state.get(messageId);
    if (timer && !timer.triggered) {
      timer.triggered = true;
    }
  }

  /**
   * Check if timeout has been reached and return true.
   */
  isTimeout(messageId: string): boolean {
    const timer = this.state.get(messageId);
    if (!timer) return false;

    const now = new Date();
    const elapsed = now.getTime() - timer.createdAt.getTime();
    return elapsed >= this.timeoutMs;
  }
}
