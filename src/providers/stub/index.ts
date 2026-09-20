/**
 * Stub provider for development.
 *
 * Logs messages to console and returns 'sent' status immediately.
 * DO NOT use in production.
 *
 * @module
 */

import type {
  Provider,
  ProviderConfig,
  ProviderSendFn,
  ProviderStatusFn,
  ProviderStatus,
  ProviderFactory,
} from './types';
import type {
  Channel,
  TemplateDefinition,
  DeliveryStatus,
  MessagingState,
  MessageStatus,
} from '../../types';

/**
 * Stub provider - for development only.
 */
export class StubProvider implements Provider {
  readonly id = 'stub';
  readonly channel = 'whatsapp' as const; // Stub supports all channels for now

  constructor(
    private readonly config: {
      name: string;
    },
    private readonly state: MessagingState,
  ) {}

  send(options: ProviderSendOptions): Promise<{
    messageId: string;
    status: Promise<ProviderStatus>;
  }> {
    // Log for debugging only - NO message body
    console.log(`[${this.id}] Sending ${options.channel} message: [SENDING...]`);

    // Generate a fake message ID
    const messageId = `${this.id}:${Date.now()}:${Math.random().toString(36).substring(7)}`;

    // Mark as sent in state
    this.state.queueMessage({
      id: messageId,
      kind: options.template.kind,
      channel: options.channel,
      status: 'pending',
      statusTimestamp: new Date(),
      templateId: options.template.id,
    });

    // Simulate delivery status after a short delay
    setTimeout(async () => {
      this.state.updateMessageStatus(messageId, 'sent', new Date());
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

  status?: ProviderStatusFn = (messageId: string): Promise<ProviderStatus> => {
    // For stub provider, always return 'sent'
    return Promise.resolve({
      status: 'sent' as const,
      timestamp: new Date(),
      details: {
        provider: this.id,
        fake: true,
      },
    });
  };

  statusHandler?: (request: Request) => Response = async (request) => {
    // Stub webhook handler - just log and return success
    console.log('[Stub] Webhook received');
    return new Response('OK', { status: 200 });
  };
}

/**
 * Factory function for the stub provider.
 */
export const stubFactory: ProviderFactory = {
  id: 'stub',
  create: (config) => new StubProvider(config.config, config.state),
};
