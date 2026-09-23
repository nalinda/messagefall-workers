/**
 * Meta Graph API request building and error mapping for the WhatsApp Cloud API.
 *
 * @module
 */

import { errorMessage } from '../../core/values.js';
import { formatHttpError, isRetryableStatus, parseJson } from '../_shared/http.js';
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
 * parameters are the template params in order; an authentication template adds
 * the copy-code button component carrying the same code. `text` renders to a
 * plain text message. Template takes precedence when both are present.
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
        components: templateComponents(templateConfig),
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

/**
 * The `components` of a template message. An authentication template's copy-code (and one-tap)
 * button is a URL button at index 0 whose single text parameter is the code, alongside the body
 * parameter carrying the same code; Meta rejects the send without it.
 */
function templateComponents(
  config: NonNullable<RenderedWhatsApp['templateConfig']>
): Record<string, unknown>[] {
  const body = {
    type: 'body',
    parameters: config.params.map((text) => ({ type: 'text', text })),
  };
  if (config.authentication !== true) {
    return [body];
  }
  const [code] = config.params;
  if (typeof code !== 'string' || config.params.length !== 1) {
    throw new Error('meta-whatsapp: an authentication template needs exactly one param, the code');
  }
  return [
    body,
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
  ];
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
      code: `graph:${code}`,
      retryable: isRetryableStatus(status) || RETRYABLE_GRAPH_CODES.has(code),
    };
  }

  return {
    ok: false,
    error: formatHttpError(status, rawText),
    code: `http:${status}`,
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
    return { ok: false, error: errorMessage(err) };
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
      error: errorMessage(err),
      code: 'network',
      retryable: true,
    };
  }

  const json = parseJson(text);
  if (response.ok) return mapSuccessResponse(json);
  return mapErrorResponse(response.status, json, text);
}
