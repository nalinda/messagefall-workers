/**
 * Meta WhatsApp Cloud API provider.
 *
 * Sends template and text messages through the Graph API `/messages`
 * endpoint and handles the status webhook: the GET subscription handshake
 * and HMAC-SHA256 signed status payloads.
 *
 * @module
 */

import type { OutboundMeta, Provider, RenderedWhatsApp, SendResult } from '../types.js';
import { messagesUrl, sendViaGraph } from './graph.js';
import { parseSignedStatuses, verifyHandshake } from './webhook.js';

/**
 * Configuration for the Meta WhatsApp Cloud API provider.
 */
export interface MetaWhatsAppConfig {
  /**
   * System user or app access token sent as a bearer token.
   */
  token: string;
  /**
   * The WhatsApp Business phone number id that sends messages.
   */
  phoneNumberId: string;
  /**
   * App secret used to verify `X-Hub-Signature-256` on webhook payloads.
   */
  appSecret: string;
  /**
   * Token expected in `hub.verify_token` during the GET handshake.
   */
  verifyToken: string;
  /**
   * Graph API version (defaults to 'v23.0').
   */
  apiVersion?: string;
  /**
   * Unique name for this provider instance (defaults to 'meta-whatsapp').
   */
  name?: string;
}

/**
 * Creates a Meta WhatsApp Cloud API provider.
 *
 * `webhook.parse` verifies `X-Hub-Signature-256` and maps each status in the
 * payload to a `StatusEvent`. When a status's `timestamp` is missing or
 * unparseable the event is still emitted, with `at` set to the webhook's
 * receipt time rather than dropped; a late-redelivered event may therefore
 * carry a later `at` than statuses that actually followed it.
 *
 * @param config - Provider configuration.
 * @returns A Provider instance for WhatsApp delivery.
 */
export function metaWhatsApp(config: MetaWhatsAppConfig): Provider<RenderedWhatsApp> {
  const url = messagesUrl(config.apiVersion ?? 'v23.0', config.phoneNumberId);
  const { token, appSecret, verifyToken } = config;

  return {
    name: config.name ?? 'meta-whatsapp',
    channel: 'whatsapp',
    send: (message: RenderedWhatsApp & OutboundMeta): Promise<SendResult> =>
      sendViaGraph({ token, url }, message),
    webhook: {
      verify: (request: Request): Promise<Response | null> =>
        Promise.resolve(verifyHandshake(request, verifyToken)),
      parse: (request: Request) => parseSignedStatuses(request, appSecret),
    },
  };
}

export default metaWhatsApp;
