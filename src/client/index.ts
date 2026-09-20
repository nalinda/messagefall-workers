/**
 * createMessagingClient
 *
 * Create a typed client for sending messages over service bindings.
 *
 * @module
 */

import type { Channel, DeliveryOverride, TemplateDef } from '../types.js';

/**
 * Client-side message status.
 */
export type ClientMessageStatus =
  | { status: 'sent'; timestamp: string; channels?: Channel[] }
  | { status: 'pending'; timestamp: string; timeoutMs?: number }
  | { status: 'delivered'; timestamp: string; provider?: string }
  | { status: 'failed'; timestamp: string; error?: string };

/**
 * Options for creating a messaging client.
 */
export interface MessagingClientOptions {
  /**
   * Service binding or app instance with a `fetch` method.
   */
  binding?: { fetch: (request: Request) => Promise<Response> | Response };
  app?: { fetch: (request: Request) => Promise<Response> | Response };
  channel?: Channel;
}

/**
 * Send options for a client send call.
 */
export interface ClientSendOptions<TInput = unknown> {
  to: string;
  locale?: string;
  input: TInput;
  delivery?: DeliveryOverride;
}

/**
 * Typed messaging client.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export class MessagingClient<
  TTemplates extends Record<string, TemplateDef<any>> = Record<string, TemplateDef<any>>,
> {
  /* eslint-enable @typescript-eslint/no-explicit-any */
  private readonly target: { fetch: (request: Request) => Promise<Response> | Response };

  constructor(options: MessagingClientOptions) {
    this.target = options.binding ??
      options.app ?? {
        fetch: () => Response.json({ ok: true }),
      };
  }

  /**
   * Send a template message.
   */
  async send<K extends keyof TTemplates>(
    template: K,
    options: ClientSendOptions<unknown>
  ): Promise<ClientMessageStatus> {
    const res = await this.target.fetch(
      new Request('https://messaging.internal/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template, ...options }),
      })
    );
    if (!res.ok) {
      return {
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: `HTTP ${res.status}`,
      };
    }
    return {
      status: 'sent',
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Create a typed client for sending messages over service binding.
 *
 * @param options - Client configuration options.
 * @returns A typed MessagingClient instance.
 */
export function createMessagingClient<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TTemplates extends Record<string, TemplateDef<any>> = Record<string, TemplateDef<any>>,
>(options: MessagingClientOptions): MessagingClient<TTemplates> {
  return new MessagingClient<TTemplates>(options);
}
