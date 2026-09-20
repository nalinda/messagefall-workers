/**
 * Virtual specifiers the workerd fixture imports. The test's build plugin resolves them to
 * `src/durable/fallback-timer.ts` / `src/core/timer.ts` when those exist, and to inert stubs
 * otherwise, so the fixture always builds and the specs fail on their assertions.
 */

declare module 'messagefall-under-test/fallback-timer' {
  import type { DurableObject } from 'cloudflare:workers';

  export class FallbackTimer extends DurableObject {
    arm(args: { id: string; afterMs: number; input: unknown; locale: string; to?: string }): Promise<void>;
    cancel(id: string): Promise<void>;
    alarm(): Promise<void>;
  }
}

declare module 'messagefall-under-test/timer' {
  import type { DurableObjectNamespace } from '@cloudflare/workers-types';

  export function armTimer(
    ns: DurableObjectNamespace | undefined,
    args: { id: string; afterMs: number; input: unknown; locale: string; to?: string }
  ): Promise<void>;
  export function cancelTimer(ns: DurableObjectNamespace | undefined, id: string): Promise<void>;
}
