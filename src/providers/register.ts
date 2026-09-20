/**
 * Provider registry.
 *
 * Maps provider IDs to their factory functions.
 *
 * @module
 */

import type { ProviderFactory } from './types';

/**
 * Registry of all providers.
 */
export const providers: Record<string, ProviderFactory> = {
  // Stub provider for development
  'stub': () => import('./stub/index.js').then(m => m.stubFactory),

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
    throw new Error(`Unknown provider: ${id}`);
  }
  return factory.create({ config, state: config.state });
}
