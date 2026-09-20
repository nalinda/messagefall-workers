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
  getState(): FallbackTimerState | null;
  /**
   * Set the timer state.
   */
  setState(state: FallbackTimerState): void;
  /**
   * Mark timer as triggered (fallback already applied).
   */
  trigger(): void;
  /**
   * Check if timeout has been reached.
   */
  isTimeout(): boolean;
}

/**
 * FallbackTimer Durable Object spec.
 */
export class FallbackTimerImpl {
  private state: Map<string, FallbackTimerState>;
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
  setState(messageId: string, timeoutMs: number): void {
    this.state.set(messageId, {
      messageId,
      timeoutMs,
      createdAt: new Date(),
      triggered: false,
    });
  }

  /**
   * Check if timeout has been reached and trigger fallback if so.
   */
  checkAndTrigger(messageId: string): boolean {
    const timer = this.state.get(messageId);
    if (!timer || timer.triggered) return false;
    
    const now = new Date();
    if (now.getTime() - timer.createdAt.getTime() >= this.timeoutMs) {
      timer.triggered = true;
      return true;
    }
    return false;
  }

  /**
   * Trigger fallback for the message.
   */
  trigger(messageId: string): void {
    const timer = this.state.get(messageId);
    if (timer && !timer.triggered) {
      timer.triggered = true;
    }
  }

  /**
   * Get triggered timers.
   */
  getTriggered(): string[] {
    return Array.from(this.state.entries())
      .filter(([_, t]) => t.triggered)
      .map(([id]) => id);
  }
}
