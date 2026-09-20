/**
 * Provider registry.
 *
 * Maps provider IDs to their factory functions.
 *
 * @module
 */

import type {
  ProviderFactory,
  Provider,
  Channel,
  MessagingState,
} from './types';

/**
 * Registry of all providers.
 */
export const providers: Record<string, ProviderFactory> = {
  // Stub provider for development
  'stub': (config: { state: MessagingState }) => new TestStubProvider(config.state),

  // TODO: Add other providers as they are developed
  // 'meta-whatsapp': () => import('./meta-whatsapp/index.js').then(m => m.metaWhatsappFactory),
  // 'twilio-sms': () => import('./twilio-sms/index.js').then(m => m.twilioSmsFactory),
  // 'vonage-sms': () => import('./vonage-sms/index.js').then(m => m.vonageSmsFactory),
  // 'gmail': () => import('./gmail/index.js').then(m => m.gmailFactory),
  // 'http-sms': () => import('./http-sms/index.js').then(m => m.httpSmsFactory),
};

/**
 * Resolve a provider by ID.
 *
 * @param id - Provider ID to resolve.
 * @returns The provider instance or null.
 */
export function getProvider(id: string, config: { state: any; channel: string }): Provider | null {
  const factory = providers[id];
  if (!factory) {
    return null;
  }
  return factory.create(config);
}

/**
 * Test stub provider implementation.
 */
export class TestStubProvider {
  readonly id = 'stub';
  readonly channel = 'whatsapp' as const;
  private readonly state: any;

  constructor(state: any) {
    this.state = state;
  }

  async send(options: {
    config: Record<string, unknown>;
    channel: Channel;
    template: any;
    input: unknown;
    policy?: any;
  }): Promise<{
    messageId: string;
    status: Promise<any>;
  }> {
    const { template, input } = options;
    const messageId = `stub-${Date.now()}`;

    if (!this.state.queue.has(messageId)) {
      this.state.queue.set(messageId, []);
    }
    this.state.queue.get(messageId)!.push({
      id: messageId,
      kind: template.kind,
      channel: options.channel,
      status: 'pending' as const,
      statusTimestamp: new Date(),
      templateId: template.id,
    });

    setTimeout(() => {
      this.state.queue.get(messageId)!.forEach((msg: any) => {
        if (msg.id === messageId) {
          msg.status = 'sent' as const;
          msg.statusTimestamp = new Date();
        }
      });
      this.storeStatus(messageId, 'sent', new Date());
    }, 100);

    return {
      messageId,
      status: Promise.resolve({
        status: 'sent' as const,
        timestamp: new Date(),
        details: {
          provider: this.id,
          fake: true,
        },
      }),
    };
  }

  status(messageId: string): Promise<any> {
    return {
      status: 'sent' as const,
      timestamp: new Date(),
      details: {
        provider: this.id,
        fake: true,
      },
    };
  }

  statusHandler?(request: Request): Response {
    console.log('[Stub] Webhook received');
    return new Response('OK', { status: 200 });
  }

  storeStatus(id: string, status: any, timestamp: Date): void {
    const entries = this.state.store.get(id) ?? [];
    entries.push({ id, status, timestamp });
    this.state.store.set(id, entries);
  }
}
