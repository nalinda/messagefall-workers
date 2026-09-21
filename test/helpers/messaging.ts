/**
 * Test helpers and type mirrors for the createMessaging send pipeline (Issue #3).
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { Channel, OutboundMeta, Provider, SendResult } from '../../src/providers/types.js';
import { defineTemplates } from '../../src/templates.js';
import type { MessagingEnv } from '../../src/types.js';

export type {
  Messaging,
  MessagingOptions,
  ProviderSet,
  StatusCallbackEvent,
} from '../../src/core/messaging.js';

/**
 * Minimal ExecutionContext shape.
 */
export interface TestExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/**
 * A fresh env with an in-memory MESSAGES_KV; one per test so provider memoisation never leaks.
 */
export function newEnv(): MessagingEnv {
  return { MESSAGES_KV: memoryKV() };
}

/**
 * The smallest valid catalogue: one sms-only notification template.
 */
export const pingTemplates = defineTemplates({
  ping: { input: z.unknown(), kind: 'notification', sms: () => 'ping' },
});

/**
 * Console method names `captureConsole` can intercept.
 */
export type ConsoleMethod = 'log' | 'info' | 'warn' | 'error';

/**
 * Intercepts the given console methods (default: all four) for the duration of a test,
 * collecting each call as one line. Objects are JSON-stringified so content assertions can see
 * into them. Call `restore()` in a `finally`.
 *
 * @param methods - Console methods to capture.
 * @returns The captured lines and a restore function.
 */
export function captureConsole(methods: ConsoleMethod[] = ['log', 'info', 'warn', 'error']): {
  logs: string[];
  restore: () => void;
} {
  const logs: string[] = [];
  const target = console as unknown as Record<ConsoleMethod, (...args: unknown[]) => void>;
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  const intercept = (...args: unknown[]): void => {
    logs.push(
      args
        .map((a) => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a)))
        .join(' ')
    );
  };
  for (const method of methods) {
    originals.set(method, Reflect.get(target, method));
    Reflect.set(target, method, intercept);
  }
  return {
    logs,
    restore: () => {
      for (const [method, original] of originals) {
        Reflect.set(target, method, original);
      }
    },
  };
}

/**
 * A recorded provider call: the full payload the core handed to `send`.
 */
export type RecordedCall<R> = R & OutboundMeta;

/**
 * Provider that records every `send` payload and replies from a queue of results.
 * When the queue is exhausted it answers `{ ok: true }`.
 */
export interface RecordingProvider<R> extends Provider<R> {
  readonly calls: RecordedCall<R>[];
}

/**
 * Creates a recording provider for a channel.
 *
 * @param channel - Channel the provider serves.
 * @param name - Provider name reported in attempts.
 * @param resultsOrSend - Either results to return, in order, one per call (the queue answers
 *   `{ ok: true }` once exhausted), or a function computing the result per call — for a test
 *   that needs the result to depend on the call (a specific `providerId`, a rejection, one
 *   channel behaving differently from another).
 * @returns A provider that records calls.
 */
export function recordingProvider<R>(
  channel: Channel,
  name: string,
  resultsOrSend: SendResult[] | ((message: RecordedCall<R>) => Promise<SendResult>) = []
): RecordingProvider<R> {
  const calls: RecordedCall<R>[] = [];
  const send = Array.isArray(resultsOrSend) ? undefined : resultsOrSend;
  const queue = Array.isArray(resultsOrSend) ? [...resultsOrSend] : [];
  return {
    name,
    channel,
    calls,
    send: (message: R & OutboundMeta): Promise<SendResult> => {
      calls.push(message);
      if (send) {
        return send(message);
      }
      const next = queue.shift() ?? { ok: true, providerId: `${name}_${calls.length}` };
      return Promise.resolve(next);
    },
  };
}

/**
 * In-memory KV double good enough for the status store (get/put/delete with string values).
 */
export function memoryKV(): KVNamespace & { dump(): Map<string, string> } {
  const data = new Map<string, string>();
  const kv = {
    get: (key: string) => Promise.resolve(data.get(key) ?? null),
    put: (key: string, value: string) => {
      data.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      data.delete(key);
      return Promise.resolve();
    },
    dump: () => data,
  };
  return kv as unknown as KVNamespace & { dump(): Map<string, string> };
}

/**
 * Polls `condition` until it holds or the budget runs out. For the asynchronous seams a test
 * cannot await directly — a provider's simulated status fires from a `setTimeout`, and the
 * record update it triggers is not tied to any promise the caller holds.
 *
 * @param condition - Checked on every poll; the wait ends as soon as it returns true.
 * @param timeoutMs - How long to keep polling before giving up.
 * @throws If the condition never holds within `timeoutMs`.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`waitFor: condition did not hold within ${timeoutMs}ms`);
}

/**
 * Self-test (see "Testing Guidelines" in `src/providers/README.md`): a helper file with
 * no `describe` of its own never shows up in the runner's output, which makes it look like a
 * red-phase test that silently failed to run. This runs with whichever spec imports the helper.
 */
describe('test/helpers/messaging', () => {
  it('loads', () => {
    expect(typeof newEnv().MESSAGES_KV.put).toBe('function');
    expect(Object.keys(pingTemplates)).toContain('ping');
    const provider = recordingProvider('sms', 'self-test-sms');
    expect(provider.name).toBe('self-test-sms');
    expect(provider.calls).toEqual([]);
    expect(typeof captureConsole).toBe('function');
  });
});
