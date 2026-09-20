/**
 * Stub provider for development and testing.
 *
 * @module
 */

import type { Channel, Provider, ProviderStatus } from '../types.js';

/**
 * Stub provider implementation.
 */
export class StubProvider implements Provider {
  readonly id = 'stub';
  readonly name = 'stub';
  readonly channel: Channel = 'whatsapp';

  send(_options: unknown): Promise<{
    ok: boolean;
    messageId: string;
    status: Promise<ProviderStatus>;
  }> {
    const messageId = `stub-${Date.now()}`;
    return Promise.resolve({
      ok: true,
      messageId,
      status: Promise.resolve({
        status: 'sent',
        timestamp: new Date(),
        details: { provider: this.id },
      }),
    });
  }

  status(_messageId: string): Promise<ProviderStatus> {
    return Promise.resolve({
      status: 'sent',
      timestamp: new Date(),
      details: { provider: this.id },
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
