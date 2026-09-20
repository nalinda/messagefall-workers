/**
 * Test helpers and type mirrors for the createMessaging send pipeline (Issue #3).
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import type { DeliveryOverride, DeliveryPolicy } from '../../src/core/policy.js';
import type { MessageRecord } from '../../src/core/status.js';
import type {
  Channel,
  DeliveryStatus,
  OutboundMeta,
  Provider,
  RenderedEmail,
  RenderedSms,
  RenderedWhatsApp,
  SendResult,
} from '../../src/providers/types.js';
import type { Templates } from '../../src/templates.js';
import type { MessagingEnv } from '../../src/types.js';

/**
 * Provider set built from env, one provider per channel at most.
 */
export interface ProviderSet {
  whatsapp?: Provider<RenderedWhatsApp>;
  sms?: Provider<RenderedSms>;
  email?: Provider<RenderedEmail>;
}

/**
 * Status event delivered to `onStatus`.
 */
export interface StatusCallbackEvent {
  id: string;
  channel: Channel;
  provider: string;
  status: DeliveryStatus;
}

/**
 * Options accepted by createMessaging.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface MessagingOptions<T extends Templates<any> = Templates<any>> {
  templates: T;
  providers: (env: MessagingEnv) => ProviderSet;
  delivery?: Partial<DeliveryPolicy> & { timeout?: { otp?: number; notification?: number } };
  kv?: KVNamespace;
  timer?: unknown;
  statusTtl?: number;
  onStatus?: (event: StatusCallbackEvent) => void | Promise<void>;
}

/**
 * Arguments to Messaging#send.
 */
export interface SendArgs {
  template: string;
  to: string;
  locale: string;
  input: unknown;
  delivery?: DeliveryOverride;
}

/**
 * Minimal ExecutionContext shape.
 */
export interface TestExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/**
 * Messaging instance returned by createMessaging.
 */
export interface Messaging {
  send(args: SendArgs, ctx?: TestExecutionContext): Promise<{ id: string }>;
  status(id: string): Promise<MessageRecord | null>;
  handleWebhook?(provider: string, request: Request, ctx?: TestExecutionContext): Promise<Response>;
}

/**
 * Messaging module API interface.
 */
export interface MessagingApi {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createMessaging: (env: MessagingEnv, options: MessagingOptions<any>) => Messaging;
}

/**
 * Loads createMessaging from src/core/messaging.js if implemented, falling back to
 * src/index.js and then to an inert stub so tests execute real assertions and fail
 * for the right reason (an assertion, not a missing import).
 */
export async function loadMessagingApi(): Promise<MessagingApi> {
  try {
    const messagingEntry = '../../src/core/messaging.js';
    const mod = (await import(messagingEntry)) as unknown as Partial<MessagingApi>;
    if (mod.createMessaging) {
      return mod as MessagingApi;
    }
  } catch {
    // messaging.js not yet implemented
  }

  const root = (await import('../../src/index.js')) as unknown as Partial<MessagingApi>;
  if (root.createMessaging) {
    return root as MessagingApi;
  }

  return {
    createMessaging: (): Messaging => ({
      send: () => Promise.resolve({ id: '' }),
      status: () => Promise.resolve(null),
      handleWebhook: () => Promise.resolve(new Response(null, { status: 501 })),
    }),
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
