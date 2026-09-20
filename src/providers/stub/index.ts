/**
 * Stub provider for development.
 *
 * Logs messages to console and returns 'sent' status immediately.
 * DO NOT use in production.
 *
 * @module
 */

import type {
  Channel,
  DeliveryStatus,
  MessagingState,
  MessageStatus,
  Provider,
} from '../../types';

/**
 * Stub provider - for development only.
 */
export class StubProvider implements Provider {
  readonly id = 'stub';
  readonly channel = 'whatsapp' as const;
  private readonly state: any;

  constructor(state: { kv: any; durable?: { class: any; id: string | number } }) {
    this.state = state;
  }

  async send(options: {
    config: Record<string, unknown>;
    channel: Channel;
    template: { kind: 'otp' | 'text' };
    input: unknown;
    policy?: any;
  }): Promise<{
    messageId: string;
    status: Promise<MessageStatus>;
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

    return Promise.resolve({
      messageId,
      status: Promise.resolve({
        status: 'sent' as const,
        timestamp: new Date(),
        details: {
          provider: this.id,
          fake: true,
        },
      }),
    });
  }

  status(messageId: string): Promise<MessageStatus> {
    this.storeStatus(messageId, 'sent', new Date());
    return Promise.resolve({
      status: 'sent' as const,
      timestamp: new Date(),
      details: {
        provider: this.id,
        fake: true,
      },
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
 * Factory function for the stub provider.
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
