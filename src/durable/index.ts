/**
 * FallbackTimer
 *
 * Durable Object for timed fallback when no delivery status arrives.
 *
 * @module
 */

import type { DurableObjectState } from '@cloudflare/workers-types';

/**
 * Fallback timer state.
 */
export interface FallbackTimerState {
  messageId: string;
  timeoutMs: number;
  createdAt: Date;
  triggered: boolean;
}

/**
 * FallbackTimer Durable Object.
 */
export class FallbackTimer {
  private readonly timerMap: Map<string, FallbackTimerState> = new Map();
  protected readonly state: DurableObjectState | undefined;

  constructor(state?: DurableObjectState, _env?: unknown) {
    this.state = state;
  }

  /**
   * Alarm handler invoked when a timer expires.
   */
  async alarm(): Promise<void> {
    await Promise.resolve();
  }

  /**
   * HTTP request handler.
   */
  fetch(_request: Request): Response {
    return new Response('OK', { status: 200 });
  }

  /**
   * Get the timer state for a message.
   */
  getState(messageId: string): FallbackTimerState | null {
    return this.timerMap.get(messageId) ?? null;
  }

  /**
   * Set a timer for a message.
   */
  setState(messageId: string, timeoutMs: number): void {
    this.timerMap.set(messageId, {
      messageId,
      timeoutMs,
      createdAt: new Date(),
      triggered: false,
    });
  }

  /**
   * Mark timer as triggered.
   */
  trigger(messageId: string): void {
    const timer = this.timerMap.get(messageId);
    if (timer) {
      timer.triggered = true;
    }
  }

  /**
   * Check if timeout has been reached.
   */
  isTimeout(messageId: string): boolean {
    const timer = this.timerMap.get(messageId);
    if (!timer) return false;
    return Date.now() - timer.createdAt.getTime() >= timer.timeoutMs;
  }
}
