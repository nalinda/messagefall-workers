/**
 * Test helpers and type mirrors for the createMessaging send pipeline (Issue #3).
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

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
  ping: { kind: 'notification', sms: () => 'ping' },
});

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
 * @param results - Results to return, in order, one per call.
 * @returns A provider that records calls.
 */
export function recordingProvider<R>(
  channel: Channel,
  name: string,
  results: SendResult[] = []
): RecordingProvider<R> {
  const calls: RecordedCall<R>[] = [];
  const queue = [...results];
  return {
    name,
    channel,
    calls,
    send: (message: R & OutboundMeta): Promise<SendResult> => {
      calls.push(message);
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
