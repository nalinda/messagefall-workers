/**
 * messagefall-workers
 *
 * Outbound messaging for Cloudflare Workers.
 *
 * @module
 */

import type {
  StandardSchema,
  ZodRawShape,
} from 'zod';
import { z } from 'zod';

/**
 * Template rendering per channel.
 */
export interface TemplateRendering {
  channel: Channel;
  options: Record<string, string>;
  name?: string;
  params?: Record<string, unknown>;
}

/**
 * Template definition.
 */
export interface TemplateDefinition {
  id: string;
  kind: TemplateKind;
  inputSchema: StandardSchema<ZodRawShape>;
  renderings: TemplateRendering[];
  deliveryPolicy?: DeliveryPolicy;
}

/**
 * Delivery policy.
 */
export interface DeliveryPolicy {
  fallbackChain?: boolean;
  alwaysOnChannels?: Channel[];
  fallbacks?: {
    from: Channel;
    to: Channel;
    timeoutMs: number;
    thresholdStatuses?: DeliveryStatus[];
  }[];
}

/**
 * Channel type.
 */
export type Channel = 'whatsapp' | 'sms' | 'email';

/**
 * Delivery status.
 */
export type DeliveryStatus =
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'undelivered'
  | 'undecipherable'
  | 'unknown';

/**
 * Template kind.
 */
export type TemplateKind = 'otp' | 'text';

/**
 * Send options.
 */
export interface SendOptions {
  channel: Channel | 'all';
  input: unknown;
  policy?: DeliveryPolicy;
  skipConfirmation?: boolean;
}

/**
 * Message status.
 */
export interface MessageStatus {
  status: DeliveryStatus;
  timestamp: Date;
  provider?: string;
  details?: Record<string, unknown>;
}

/**
 * Supported channels.
 */
export const CHANNELS = ['whatsapp', 'sms', 'email'] as const;

/**
 * Stub provider for development.
 */
export class StubProvider {
  readonly id = 'stub';
  readonly channel = 'whatsapp';
  private state: any;

  constructor(state: any) {
    this.state = state;
  }

  async send(options: {
    config: Record<string, unknown>;
    channel: Channel;
    template: TemplateDefinition;
    input: unknown;
    policy?: DeliveryPolicy;
  }): Promise<{
    messageId: string;
    status: Promise<MessageStatus>;
  }> {
    const { template, channel, input } = options;
    const messageId = `stub-${Date.now()}`;

    if (!this.state.queue.has(messageId)) {
      this.state.queue.set(messageId, []);
    }
    this.state.queue.get(messageId)!.push({
      id: messageId,
      kind: template.kind,
      channel,
      status: 'pending' as const,
      statusTimestamp: new Date(),
      templateId: template.id,
    });

    setTimeout(() => {
      this.state.queue.get(messageId)!.forEach((m) => {
        if (m.id === messageId) {
          m.status = 'sent' as const;
          m.statusTimestamp = new Date();
        }
      });
      this.storeStatus(messageId, 'sent', new Date());
    }, 100);

    return {
      messageId,
      status: Promise.resolve({
        status: 'sent',
        timestamp: new Date(),
      }),
    };
  }

  status(messageId: string): Promise<MessageStatus> {
    this.storeStatus(messageId, 'sent', new Date());
    return Promise.resolve({
      status: 'sent',
      timestamp: new Date(),
    });
  }

  statusHandler?(request: Request): Response {
    console.log('[Stub] Webhook received');
    return new Response('OK', { status: 200 });
  }

  storeStatus(id: string, status: DeliveryStatus, timestamp: Date): void {
    const entries = this.state.store.get(id) ?? [];
    entries.push({ id, status, timestamp });
    this.state.store.set(id, entries);
  }
}

/**
 * Factory for stub provider.
 */
export const stubFactory = {
  id: 'stub',
  create: (config: { state: any }) => new StubProvider(config.state),
};

/**
 * Stub provider factory for testing.
 */
export const testStubFactory = {
  id: 'stub',
  create: (config: { state: any }) => new StubProvider(config.state),
};

/**
 * Test status provider.
 */
export class TestStatusProvider {
  readonly id = 'test-status';
  readonly channel = 'whatsapp';
  private state: any;

  constructor(state: any) {
    this.state = state;
  }

  async send(options: {
    config: Record<string, unknown>;
    channel: Channel;
    template: TemplateDefinition;
    input: unknown;
    policy?: DeliveryPolicy;
  }): Promise<{
    messageId: string;
    status: Promise<MessageStatus>;
  }> {
    const messageId = `test-${Date.now()}`;
    this.state.queue.set(messageId, []);

    return {
      messageId,
      status: Promise.resolve({
        status: 'sent',
        timestamp: new Date(),
      }),
    };
  }

  async status(messageId: string): Promise<MessageStatus> {
    return {
      status: 'sent',
      timestamp: new Date(),
    };
  }

  async statusHandler(request: Request): Promise<Response> {
    return new Response('OK', { status: 200 });
  }
}

/**
 * Test status provider factory.
 */
export const testStatusProviderFactory = {
  id: 'test-status',
  create: (config: { state: any; channel: string }) => new TestStatusProvider(config.state),
};

/**
 * Test email provider.
 */
export class TestEmailProvider {
  readonly id = 'test-email';
  readonly channel = 'email';

  async send(options: {
    config: Record<string, unknown>;
    channel: Channel;
    template: TemplateDefinition;
    input: unknown;
    policy?: DeliveryPolicy;
  }): Promise<{
    messageId: string;
    status: Promise<MessageStatus>;
  }> {
    return {
      messageId: `test-email-${Date.now()}`,
      status: Promise.resolve({
        status: 'sent',
        timestamp: new Date(),
      }),
    };
  }
}

/**
 * Test email factory.
 */
export const testEmailProviderFactory = {
  id: 'test-email',
  create: (config: { state: any }) => new TestEmailProvider(config.state),
};

/**
 * Test SMS provider.
 */
export class TestSmsProvider {
  readonly id = 'test-sms';
  readonly channel = 'sms';

  async send(options: {
    config: Record<string, unknown>;
    channel: Channel;
    template: TemplateDefinition;
    input: unknown;
    policy?: DeliveryPolicy;
  }): Promise<{
    messageId: string;
    status: Promise<MessageStatus>;
  }> {
    return {
      messageId: `test-sms-${Date.now()}`,
      status: Promise.resolve({
        status: 'sent',
        timestamp: new Date(),
      }),
    };
  }
}

/**
 * Test SMS factory.
 */
export const testSmsProviderFactory = {
  id: 'test-sms',
  create: (config: { state: any }) => new TestSmsProvider(config.state),
};

/**
 * Test WhatsApp provider.
 */
export class TestWhatsappProvider {
  readonly id = 'test-whatsapp';
  readonly channel = 'whatsapp';

  async send(options: {
    config: Record<string, unknown>;
    channel: Channel;
    template: TemplateDefinition;
    input: unknown;
    policy?: DeliveryPolicy;
  }): Promise<{
    messageId: string;
    status: Promise<MessageStatus>;
  }> {
    return {
      messageId: `test-wa-${Date.now()}`,
      status: Promise.resolve({
        status: 'sent',
        timestamp: new Date(),
      }),
    };
  }
}

/**
 * Test WhatsApp factory.
 */
export const testWhatsappProviderFactory = {
  id: 'test-whatsapp',
  create: (config: { state: any }) => new TestWhatsappProvider(config.state),
};

/**
 * Messaging config.
 */
export interface MessagingConfig {
  kv: KVNamespace;
  durable?: {
    class: any;
    id: string | number;
  };
  fallbackTimeoutMs?: number;
  deliveryPolicy?: DeliveryPolicy;
  providers: {
    id: string;
    config: Record<string, unknown>;
    state: any;
  }[];
}

/**
 * Create messaging state.
 */
export function createMessaging(config: MessagingConfig): MessagingState {
  const state: MessagingState = {
    templates: new Map(),
    queue: new Map(),
    store: new Map(),
    providers: new Map(),
    policy: config.deliveryPolicy ?? { fallbackChain: false },
    fallbackTimeout: config.fallbackTimeoutMs ?? 10000,
    ctx: undefined,
  };

  // Register templates
  for (const template of state.templates.values()) {
    // stub
  }

  // Register providers
  for (const { id, config: providerConfig, state: providerState } of config.providers) {
    const factory = getFactory(id);
    if (factory) {
      state.providers.set(id, factory.create({ state: providerState }));
    }
  }

  return state;
}

/**
 * Factory registry.
 */
function getFactory(id: string): { id: string; create: (config: any) => any } | undefined {
  const registry = new Map([
    ['stub', testStubFactory],
    ['test-status', testStatusProviderFactory],
    ['test-email', testEmailProviderFactory],
    ['test-sms', testSmsProviderFactory],
    ['test-whatsapp', testWhatsappProviderFactory],
  ]);
  return registry.get(id);
}

/**
 * Queue a message.
 */
export function queueMessage(state: MessagingState, id: string): void {
  if (!state.queue.has(id)) {
    state.queue.set(id, []);
  }
}

/**
 * Store message status.
 */
export function storeStatus(state: MessagingState, id: string, status: DeliveryStatus, timestamp: Date): void {
  const entries = state.store.get(id) ?? [];
  entries.push({ id, status, timestamp });
  state.store.set(id, entries);
}

/**
 * Update message status.
 */
export function updateStatus(state: MessagingState, id: string, status: DeliveryStatus, timestamp: Date): void {
  const queue = state.queue.get(id);
  if (queue) {
    queue.forEach((msg, idx) => {
      if (msg.id === id) {
        state.queue.set(id, queue.slice(0, idx + 1));
      }
    });
  }
}

/**
 * Create messaging instance.
 */
export function createMessagingInstance(config: MessagingConfig): MessagingState {
  return createMessaging(config);
}
