/**
 * Generic HTTP SMS gateway provider.
 *
 * Configurable skeleton for regional SMS gateways that expose plain HTTP APIs.
 *
 * @module
 */

import { errorMessage } from '../../core/values.js';
import { formatHttpError, isRetryableStatus } from '../_shared/http.js';
import type { OutboundMeta, Provider, RenderedSms, SendResult, StatusEvent } from '../types.js';

/**
 * Configuration options for the generic HTTP SMS provider.
 */
export interface HttpSmsOptions {
  /**
   * Target endpoint URL or a function returning the URL for a given message.
   */
  url: string | ((m: RenderedSms & OutboundMeta) => string);
  /**
   * HTTP request method (defaults to 'POST').
   */
  method?: 'POST' | 'GET';
  /**
   * Request headers or a function returning headers for a given message.
   */
  headers?: Record<string, string> | ((m: RenderedSms & OutboundMeta) => Record<string, string>);
  /**
   * Request body mapper. JSON-encoded unless a string is returned; omitted for GET.
   */
  body?: (m: RenderedSms & OutboundMeta) => unknown;
  /**
   * Function to extract the provider message ID from parsed response JSON or Response.
   */
  messageId?: (json: unknown, response: Response) => string | undefined;
  /**
   * Custom success predicate (defaults to response.ok).
   */
  ok?: (response: Response, json: unknown) => boolean;
  /**
   * Custom retryable predicate (defaults to 429 or 5xx).
   */
  retryable?: (response: Response, json: unknown) => boolean;
  /**
   * Optional webhook parser for handling delivery reports from the gateway.
   */
  webhook?: {
    /**
     * Handshake verification (e.g. GET challenge verification). Returns null if not a verification request.
     */
    verify?(request: Request): Promise<Response | null>;
    /**
     * Parse webhook delivery status payload into status events.
     */
    parse: (request: Request) => Promise<StatusEvent[]>;
  };
  /**
   * Unique name for this provider instance (defaults to 'http-sms').
   */
  name?: string;
}

function buildHeaders(
  c: HttpSmsOptions,
  message: RenderedSms & OutboundMeta,
  hasJsonBody: boolean
): Record<string, string> {
  const userHeaders = typeof c.headers === 'function' ? c.headers(message) : (c.headers ?? {});
  if (hasJsonBody) {
    return {
      'content-type': 'application/json',
      ...userHeaders,
    };
  }
  return { ...userHeaders };
}

function buildRequestBodyAndHeaders(
  c: HttpSmsOptions,
  message: RenderedSms & OutboundMeta,
  method: 'POST' | 'GET'
): { body: string | undefined; headers: Record<string, string> } {
  if (method === 'GET' || !c.body) {
    return {
      body: undefined,
      headers: buildHeaders(c, message, false),
    };
  }

  const evaluated = c.body(message);
  if (typeof evaluated === 'string') {
    return {
      body: evaluated,
      headers: buildHeaders(c, message, false),
    };
  }

  return {
    body: JSON.stringify(evaluated),
    headers: buildHeaders(c, message, true),
  };
}

async function parseResponsePayload(response: Response): Promise<{ text: string; json: unknown }> {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  const isJson =
    contentType.toLowerCase().includes('application/json') ||
    contentType.toLowerCase().includes('+json');

  if (isJson && text.length > 0) {
    try {
      return { text, json: JSON.parse(text) as unknown };
    } catch {
      return { text, json: undefined };
    }
  }

  return { text, json: undefined };
}

/**
 * Creates a generic HTTP SMS provider.
 *
 * @param c - Configuration options for the HTTP SMS provider.
 * @returns A Provider instance for SMS delivery.
 */
export function httpSms(c: HttpSmsOptions): Provider<RenderedSms> {
  const providerName = c.name ?? 'http-sms';
  const method = c.method ?? 'POST';

  const provider: Provider<RenderedSms> = {
    name: providerName,
    channel: 'sms',
    send: async (message: RenderedSms & OutboundMeta): Promise<SendResult> => {
      const url = typeof c.url === 'function' ? c.url(message) : c.url;
      const { body, headers } = buildRequestBodyAndHeaders(c, message, method);

      let response: Response;
      let payload: { text: string; json: unknown };

      try {
        response = await fetch(url, {
          method,
          headers,
          body,
        });
        payload = await parseResponsePayload(response);
      } catch (err) {
        return {
          ok: false,
          error: errorMessage(err),
          code: 'network',
          retryable: true,
        };
      }

      const isOk = c.ok ? c.ok(response, payload.json) : response.ok;

      if (isOk) {
        const providerId = c.messageId ? c.messageId(payload.json, response) : undefined;
        if (providerId !== undefined) {
          return {
            ok: true,
            providerId,
          };
        }
        return {
          ok: true,
        };
      }

      const isRetryable = c.retryable
        ? c.retryable(response, payload.json)
        : isRetryableStatus(response.status);

      return {
        ok: false,
        error: formatHttpError(response.status, payload.text),
        code: `http:${response.status}`,
        retryable: isRetryable,
      };
    },
  };

  if (c.webhook) {
    provider.webhook = c.webhook;
  }

  return provider;
}

export default httpSms;
