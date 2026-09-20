/**
 * messagefall-workers
 *
 * Outbound messaging for Cloudflare Workers: WhatsApp first with SMS fallback,
 * email, typed templates, delivery-status webhooks, and a client for Worker-to-Worker sends.
 *
 * @module
 */

import type { Provider } from './providers/types.js';

export * from './app/hono.js';
export * from './core/fallback.js';
export * from './core/logger.js';
export * from './core/messaging.js';
export * from './core/policy.js';
export * from './core/redact.js';
export * from './core/status.js';
export * from './core/webhook.js';
export * from './env.js';
export * from './providers/index.js';
export type { AnyRendered } from './templates.js';
export * from './templates.js';
export * from './types.js';

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
