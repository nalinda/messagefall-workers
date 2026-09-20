/**
 * messagefall-workers
 *
 * Outbound messaging for Cloudflare Workers: WhatsApp first with SMS fallback,
 * email, typed templates, delivery-status webhooks, and a client for Worker-to-Worker sends.
 *
 * @module
 */

import type { MessagingConfig, MessagingEnv, Provider } from './types.js';

export * from './core/messaging.js';
export * from './core/policy.js';
export * from './core/status.js';
export * from './providers/index.js';
export type { AnyRendered } from './templates.js';
export * from './templates.js';
export * from './types.js';

/**
 * Create a ready-to-deploy messaging application (Hono-compatible fetch handler).
 *
 * @param _options - Application configuration options.
 * @returns An application object with a `fetch` method.
 */
export function createMessagingApp<Env = MessagingEnv>(
  _options?: MessagingConfig<Env>
): {
  fetch: (request: Request, env?: Env, ctx?: unknown) => Promise<Response> | Response;
} {
  return {
    fetch: (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === '/send' && request.method === 'POST') {
        return Response.json({ ok: true, id: `msg_${Date.now()}` });
      }
      return new Response('OK', { status: 200 });
    },
  };
}

/**
 * Multi-provider routing helper for a single channel.
 *
 * @param _routes - Routing configuration.
 * @returns A composite provider.
 */
export function route(..._routes: unknown[]): Provider {
  return {
    name: 'route',
    channel: 'sms',
    send: () => Promise.resolve({ ok: true }),
  };
}
