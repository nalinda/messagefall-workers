/**
 * createMessagingClient
 *
 * Create a typed client for sending messages over service binding.
 *
 * @module
 */

import type { Channel, ClientMessageStatus, ClientMessageType, MessagingClientOptions } from './types';

/**
 * Client messaging client.
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
      channels: channel ? [channel] : ['whatsapp', 'sms', 'email'],
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
 * Send a message via the client.
 */
export async function send(options: MessagingClientOptions & { templateId: string; input: unknown; channel?: Channel }): Promise<ClientMessageStatus> {
  const client = createMessagingClient(options);
  return client.send(options.templateId, options.input, options.channel);
}
