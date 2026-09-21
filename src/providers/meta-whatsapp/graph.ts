/**
 * Meta Graph API request building and error mapping for the WhatsApp Cloud API.
 *
 * @module
 */

import { formatHttpError, isRetryableStatus } from '../_shared/http.js';
import type { OutboundMeta, RenderedWhatsApp, SendResult } from '../types.js';

/**
 * Graph error codes that indicate a transient rate limit and are safe to retry.
 *
 * - 130429: Cloud API rate limit hit.
 * - 131056: (Business Account, Consumer Account) pair rate limit hit.
 */
const RETRYABLE_GRAPH_CODES: ReadonlySet<number> = new Set([130_429, 131_056]);

const GRAPH_BASE_URL = 'https://graph.facebook.com';

/**
 * Shape of an error returned by the Graph API.
 */
export interface GraphError {
  message: string;
  type?: string;
  code: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

/**
 * Body of a successful Cloud API `/messages` response.
 */
export interface GraphMessagesResponse {
  messaging_product?: string;
  contacts?: { input: string; wa_id: string }[];
  messages?: { id: string }[];
}

/**
 * Cloud API `/messages` endpoint for a phone number id and API version.
 */
export function messagesUrl(apiVersion: string, phoneNumberId: string): string {
  return `${GRAPH_BASE_URL}/${apiVersion}/${phoneNumberId}/messages`;
}

/**
 * Build the Cloud API `/messages` body for a rendered WhatsApp message.
 *
 * A `template` renders to a template message with one body component whose
 * parameters are the template params in order; `text` renders to a plain
 * text message. Template takes precedence when both are present.
 *
 * @throws When the message carries neither a template nor text.
 */
export function buildMessageBody(
  message: RenderedWhatsApp & OutboundMeta
): Record<string, unknown> {
  const base = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: message.to,
  };

  const { templateConfig } = message;
  if (templateConfig) {
    return {
      ...base,
      type: 'template',
      template: {
        name: templateConfig.name,
        language: { code: templateConfig.language },
        components: [
          {
            type: 'body',
            parameters: templateConfig.params.map((text) => ({ type: 'text', text })),
          },
        ],
      },
    };
  }

  if (typeof message.text === 'string') {
    return {
      ...base,
      type: 'text',
      text: { body: message.text },
    };
  }

  throw new Error('meta-whatsapp: message has neither a template nor text to send');
}

function isGraphError(value: unknown): value is { error: GraphError } {
  if (typeof value !== 'object' || value === null) return false;
  const { error } = value as { error?: unknown };
  if (typeof error !== 'object' || error === null) return false;
  const { message, code } = error as { message?: unknown; code?: unknown };
  return typeof message === 'string' && typeof code === 'number';
}

/**
 * Map a non-OK Cloud API response to a failed `SendResult`.
 *
 * HTTP 429 and 5xx are retryable, as are the Graph rate-limit codes
 * regardless of HTTP status. Everything else is a plain failure whose
 * `error` carries the Graph message and code when the body is a Graph error.
 */
export function mapErrorResponse(status: number, body: unknown, rawText: string): SendResult {
  if (isGraphError(body)) {
    const { message, code } = body.error;
    return {
      ok: false,
      error: `Graph error ${code}: ${message}`,
      retryable: isRetryableStatus(status) || RETRYABLE_GRAPH_CODES.has(code),
    };
  }

  return {
    ok: false,
    error: formatHttpError(status, rawText),
    retryable: isRetryableStatus(status),
  };
}

/**
 * Map a successful Cloud API response to `SendResult`, taking `providerId`
 * from `messages[0].id` when present.
 */
export function mapSuccessResponse(body: unknown): SendResult {
  const id = (body as GraphMessagesResponse | undefined)?.messages?.[0]?.id;
  return typeof id === 'string' ? { ok: true, providerId: id } : { ok: true };
}

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Send a rendered message through the Cloud API and map the outcome.
 */
export async function sendViaGraph(
  options: { token: string; url: string },
  message: RenderedWhatsApp & OutboundMeta
): Promise<SendResult> {
  let body: string;
  try {
    body = JSON.stringify(buildMessageBody(message));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  let response: Response;
  let text: string;
  try {
    response = await fetch(options.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json',
      },
      body,
    });
    text = await response.text();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      retryable: true,
    };
  }

  const json = parseJson(text);
  if (response.ok) return mapSuccessResponse(json);
  return mapErrorResponse(response.status, json, text);
}
