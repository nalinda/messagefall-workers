/**
 * Test helpers for messagefall-workers.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import type {
  Channel,
  DeliveryPolicy,
  DeliveryStatus,
  MessageStatusEntry,
  MessagingState,
  OutboundMeta,
  Provider,
  SendResult,
  TemplateDefinition,
} from '../../src/types.js';

const defaultPolicy: DeliveryPolicy = { fallback: ['whatsapp', 'sms'], always: [] };

/**
 * Create a test messaging state.
 */
export function createTestState(): MessagingState {
  return {
    templates: new Map([
      ['otp', createTestTemplate('otp')],
      ['text', createTestTemplate('text')],
    ]),
    queue: new Map(),
    store: new Map(),
    providers: new Map(),
    policy: {
      fallback: ['whatsapp', 'sms'],
      always: [],
    },
    fallbackTimeout: 10_000,
  };
}

/**
 * Create a test template.
 */
export function createTestTemplate(kind: 'otp' | 'text'): TemplateDefinition {
  return {
    id: kind,
    kind,
    inputSchema: {
      type: 'object',
      shape: {
        name: { type: 'string' },
      },
    },
    renderings: [
      { channel: 'whatsapp', options: { text: 'Hello, {name}!' } },
      { channel: 'sms', options: { text: 'Hello, {name}!' } },
      { channel: 'email', options: { text: 'Hello, {name}!' } },
    ],
  };
}

/**
 * Create a test message.
 */
export function createMessage(
  templateId: string,
  input: Record<string, string>,
  policy?: DeliveryPolicy
): {
  template: TemplateDefinition;
  policy: DeliveryPolicy;
  input: unknown;
  kind: 'otp' | 'text';
} {
  return {
    template: createTestTemplate(templateId as 'otp' | 'text'),
    policy: policy ?? defaultPolicy,
    input,
    kind: templateId as 'otp' | 'text',
  };
}

/**
 * KV mock for testing.
 */
export class MockKVNamespace {
  private readonly data: Map<string, string> = new Map();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.data.get(key) ?? null);
  }

  put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.data.delete(key);
    return Promise.resolve();
  }
}

/**
 * Mock KV namespace with bindings.
 */
export function createMockKV(): KVNamespace {
  const kv = new MockKVNamespace();
  void kv.put('templates:otp', JSON.stringify({ id: 'otp', kind: 'otp', renderings: [] }));
  void kv.put('templates:text', JSON.stringify({ id: 'text', kind: 'text', renderings: [] }));
  return kv as unknown as KVNamespace;
}

/**
 * Get message status from store.
 */
export function getMessageStatus(
  id: string,
  store: Map<string, MessageStatusEntry[]>
): MessageStatusEntry {
  const entries = store.get(id) ?? [];
  const latest = entries.at(-1);
  if (!latest) {
    throw new Error(`No status for message ${id}`);
  }
  return latest;
}

/**
 * Update message status.
 */
export function updateMessageStatus(
  store: Map<string, MessageStatusEntry[]>,
  id: string,
  status: DeliveryStatus,
  timestamp: Date
): void {
  if (!store.has(id)) {
    store.set(id, []);
  }
  const arr = store.get(id);
  if (arr) {
    arr.push({ id, status, timestamp });
  }
}

/**
 * Provider test utilities.
 */
export type TestProvider = { readonly id: string; readonly channel: Channel };

export function createTestProvider(
  id: string,
  channel: Channel
): TestProvider {
  return {
    id,
    channel,
  };
}

/**
 * Basic provider implementation for testing.
 */
export class BasicProvider implements Provider {
  readonly id = 'test-basic';
  readonly name = 'test-basic';
  readonly channel: Channel = 'whatsapp';

  send(_options: OutboundMeta): Promise<SendResult> {
    const messageId = `test-${Date.now()}`;
    return Promise.resolve({
      ok: true,
      providerId: messageId,
    });
  }
}

/**
 * Extra provider factory for testing.
 */
export const testBasicFactory = {
  id: 'test-basic',
  create: (): BasicProvider => new BasicProvider(),
};
