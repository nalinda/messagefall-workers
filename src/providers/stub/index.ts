/**
 * Stub provider for development and testing.
 *
 * @module
 */

import type { Channel, OutboundMeta, Provider, SendResult, StatusEvent } from '../types.js';

/**
 * Stub provider implementation.
 */
export class StubProvider implements Provider {
  readonly id = 'stub';
  readonly name = 'stub';
  readonly channel: Channel = 'whatsapp';

  send(_options: OutboundMeta): Promise<SendResult> {
    const messageId = `stub-${Date.now()}`;
    return Promise.resolve({
      ok: true,
      providerId: messageId,
    });
  }

  status(_messageId: string): Promise<StatusEvent> {
    return Promise.resolve({
      providerId: this.id,
      status: 'sent',
      at: new Date().toISOString(),
    });
  }

  statusHandler(_request: Request): Response {
    return new Response('OK', { status: 200 });
  }
}

/**
 * Create a stub provider.
 *
 * @param _config - Optional provider configuration.
 * @returns A StubProvider instance.
 */
export function stub(_config?: unknown): StubProvider {
  return new StubProvider();
}

/**
 * Stub provider factory.
 */
export const stubFactory = {
  id: 'stub',
  create: (_config?: unknown): StubProvider => new StubProvider(),
};
