/**
 * Gmail API email provider.
 *
 * Sends emails through the Gmail API `users.messages.send` endpoint
 * authenticated via OAuth 2.0 refresh tokens.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import { errorMessage } from '../../core/values.js';
import { formatHttpError, isRetryableStatus, parseJson } from '../_shared/http.js';
import { buildMimeMessage, encodeBase64 } from '../_shared/mime.js';
import type { OutboundMeta, Provider, RenderedEmail, SendResult } from '../types.js';
import { createGmailTokenManager, type GmailTokenManager } from './oauth.js';

/**
 * Configuration options for the Gmail email provider.
 */
export interface GmailConfig {
  /**
   * OAuth 2.0 Client ID.
   */
  clientId: string;
  /**
   * OAuth 2.0 Client Secret.
   */
  clientSecret: string;
  /**
   * OAuth 2.0 Refresh Token with gmail.send scope.
   */
  refreshToken: string;
  /**
   * Sender email address (account or verified alias).
   */
  from: string;
  /**
   * Unique name for this provider instance (defaults to 'gmail').
   */
  name?: string;
  /**
   * Optional Cloudflare KV namespace for cross-isolate token caching.
   */
  tokenCache?: KVNamespace;
}

interface GoogleErrorPayload {
  error?:
    | string
    | {
        code?: number;
        message?: string;
        status?: string;
      };
  error_description?: string;
  message?: string;
}

/**
 * Encodes a string to standard Base64URL without padding.
 */
function encodeBase64Url(str: string): string {
  return encodeBase64(str, { urlSafe: true });
}

function extractGoogleError(error: GoogleErrorPayload['error']): string | undefined {
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  if (typeof error === 'object' && typeof error.message === 'string' && error.message.length > 0) {
    return error.message;
  }
  return undefined;
}

function extractErrorMessage(status: number, text: string, json: unknown): string {
  if (typeof json === 'object' && json !== null) {
    const payload = json as GoogleErrorPayload;
    const fromError = extractGoogleError(payload.error);
    if (fromError !== undefined) return fromError;
    if (typeof payload.error_description === 'string' && payload.error_description.length > 0) {
      return payload.error_description;
    }
    if (typeof payload.message === 'string' && payload.message.length > 0) {
      return payload.message;
    }
  }
  return formatHttpError(status, text);
}

function postGmailSend(token: string, raw: string): Promise<Response> {
  return fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });
}

async function sendWithToken(
  tokenManager: GmailTokenManager,
  raw: string
): Promise<{ response?: Response; errorResult?: SendResult }> {
  let token: string;
  try {
    token = await tokenManager.getToken();
  } catch (err) {
    return {
      errorResult: {
        ok: false,
        error: errorMessage(err),
        retryable: true,
      },
    };
  }

  let response: Response;
  try {
    response = await postGmailSend(token, raw);
  } catch (err) {
    return {
      errorResult: {
        ok: false,
        error: errorMessage(err),
        retryable: true,
      },
    };
  }

  if (response.status === 401) {
    await tokenManager.invalidate();
    try {
      token = await tokenManager.getToken();
      response = await postGmailSend(token, raw);
    } catch (err) {
      return {
        errorResult: {
          ok: false,
          error: errorMessage(err),
          retryable: true,
        },
      };
    }
  }

  return { response };
}

async function mapSendResponse(response: Response): Promise<SendResult> {
  const text = await response.text();
  const json = parseJson(text);

  if (response.ok) {
    const providerId = (json as { id?: string } | undefined)?.id;
    return typeof providerId === 'string' ? { ok: true, providerId } : { ok: true };
  }

  const error = extractErrorMessage(response.status, text, json);
  const isRetryable = response.status === 401 ? false : isRetryableStatus(response.status);

  return {
    ok: false,
    error,
    retryable: isRetryable,
  };
}

/**
 * Creates a Gmail API email provider.
 *
 * @param c - Provider configuration.
 * @returns A Provider instance for email delivery.
 */
export function gmail(c: GmailConfig): Provider<RenderedEmail> {
  const providerName = c.name ?? 'gmail';
  const tokenManager = createGmailTokenManager({
    clientId: c.clientId,
    clientSecret: c.clientSecret,
    refreshToken: c.refreshToken,
    tokenCache: c.tokenCache,
  });

  return {
    name: providerName,
    channel: 'email',
    send: async (message: RenderedEmail & OutboundMeta): Promise<SendResult> => {
      const mime = buildMimeMessage({
        from: c.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });

      const raw = encodeBase64Url(mime);
      const { response, errorResult } = await sendWithToken(tokenManager, raw);

      if (errorResult !== undefined) {
        return errorResult;
      }

      return mapSendResponse(response!);
    },
  };
}

export default gmail;
