/**
 * createMessagingClient
 *
 * Create a typed client for sending messages over service binding.
 *
 * @module
 */

export * from './types';

/**
 * Client messaging options.
 */
export interface MessagingClientOptions {
  /**
   * Messaging app instance or binding.
   */
  app: { fetch: (request: Request) => Response };
  /**
   * Default channel.
   */
  channel?: Channel;
}

/**
 * Create a messaging client.
 */
export function createMessagingClient(options: MessagingClientOptions): MessagingClient {
  return new MessagingClient(options);
}

/**
 * Messaging client class.
 */
export class MessagingClient {
  private readonly channel: Channel | undefined;
  private readonly app: { fetch: (request: Request) => Response };

  constructor(options: MessagingClientOptions) {
    this.app = options.app;
    this.channel = options.channel;
  }

  async send(templateId: string, input: unknown, channel: Channel | undefined = this.channel): Promise<ClientMessageStatus> {
    // TODO: Implement actual send logic
    return {
      status: 'sent' as const,
      timestamp: new Date().toISOString(),
      channels: [channel || 'whatsapp'],
    };
  }
}

/**
 * Client-side message status.
 */
export type ClientMessageStatus =
  | { status: 'sent'; timestamp: string; channels: Channel[] }
  | { status: 'pending'; timestamp: string; timeoutMs: number }
  | { status: 'delivered'; timestamp: string; provider?: string }
  | { status: 'failed'; timestamp: string; error: string };

/**
 * Client message type.
 */
export type ClientMessageType = 'text' | 'otp';
