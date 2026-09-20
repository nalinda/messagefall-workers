/**
 * Test helpers for messagefall-workers.
 */

import type {
  MessageState,
  DeliveryStatus,
  Channel,
  TemplateDefinition,
  MessagingState,
  MessageStatus,
  Provider,
} from '../../src/types';
import type { DurableObject } from '@cloudflare/workers-types';

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
      fallbackChain: false,
      alwaysOnChannels: [],
    },
    fallbackTimeout: 10000,
  };
}

/**
 * Create a test template.
 */
function createTestTemplate(kind: 'otp' | 'text'): TemplateDefinition {
  return {
    id: kind,
    kind,
    inputSchema: {
      type: 'object' as const,
      shape: {
        name: { type: 'string' as const },
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
  policy = { fallbackChain: false },
): {
  template: TemplateDefinition;
  policy: any;
  input: unknown;
  kind: 'otp' | 'text';
} {
  return {
    template: createTestTemplate(templateId as 'otp' | 'text'),
    policy,
    input,
    kind: templateId,
  };
}

/**
 * KV mock for testing.
 */
export class MockKVNamespace implements KVNamespace {
  private data: Map<string, string>;

  constructor() {
    this.data = new Map();
  }

  async get(key: string): Promise<string | null> {
    return this.data.get(key);
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

/**
 * Mock KV namespace with bindings.
 */
export function createMockKV(): MockKVNamespace {
  const kv = new MockKVNamespace();
  
  // Pre-populate with some test data
  kv.put('templates:otp', JSON.stringify({ id: 'otp', kind: 'otp', renderings: [] }));
  kv.put('templates:text', JSON.stringify({ id: 'text', kind: 'text', renderings: [] }));
  
  return kv;
}

/**
 * Message status entry.
 */
export interface MessageStatusEntry {
  id: string;
  status: DeliveryStatus;
  timestamp: Date;
}

/**
 * Get message status from store.
 */
export function getMessageStatus(
  id: string,
  store: Map<string, MessageStatusEntry[]>
): { status: DeliveryStatus; timestamp: Date } {
  const entries = store.get(id) ?? [];
  if (entries.length === 0) {
    throw new Error(`No status for message ${id}`);
  }
  return entries[entries.length - 1];
}

/**
 * Update message status.
 */
export function updateMessageStatus(
  store: Map<string, MessageStatusEntry[]>,
  id: string,
  status: DeliveryStatus,
  timestamp: Date,
): void {
  if (!store.has(id)) {
    store.set(id, []);
  }
  store.get(id)!.push({ id, status, timestamp });
}

/**
 * Provider test utilities.
 */
export interface TestProvider implements Provider {
  readonly id: string;
  readonly channel: Channel;
}

export function createTestProvider(
  id: string,
  channel: Channel,
  state: any,
): TestProvider {
  return {
    id,
    channel,
    async send(options: any) {
      return {
        messageId: `test-${Date.now()}`,
        status: Promise.resolve({
          status: 'sent' as const,
          timestamp: new Date(),
          details: { test: true },
        }),
      };
    },
    status: async (messageId: string) => {
      return {
        status: 'sent' as const,
        timestamp: new Date(),
        details: { test: true },
      };
    },
    statusHandler: async (_request: Request) => {
      return new Response('OK', { status: 200 });
    },
  };
}

/**
 * Run async functions with mock execution context.
 */
export async function runWithContext<T>(
  fn: () => Promise<T>,
  waitUntil: (reason: Promise<any>) => void,
): Promise<T> {
  return (await fn())
    .then(waitUntil)
    .catch((err) => waitUntil(Promise.reject(err)));
}
