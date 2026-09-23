/**
 * createMessagingClient
 *
 * Create a typed client for sending messages over service bindings.
 *
 * @module
 */

import type { Fetcher } from '@cloudflare/workers-types';

import { normalizeBasePath } from '../core/base-path.js';
import type { MessageRecord } from '../core/status.js';
import { isRecord } from '../core/values.js';
import type { InputOf, Templates } from '../templates.js';

/**
 * Narrowed channel names defined by a template definition.
 */
export type DefinedChannelsOf<Def> =
  | (Def extends { whatsapp: unknown } ? 'whatsapp' : never)
  | (Def extends { sms: unknown } ? 'sms' : never)
  | (Def extends { email: unknown } ? 'email' : never);

/**
 * Narrows fallback and always delivery overrides to the channels template K defines, or 'all'.
 */
export type DeliveryOverrideFor<T, K extends keyof T> =
  | 'all'
  | {
      fallback?: DefinedChannelsOf<T[K]>[];
      always?: DefinedChannelsOf<T[K]>[];
    };

/**
 * Arguments for client send.
 */
export interface ClientSendArgs<T, K extends keyof T> {
  to: string;
  email?: string;
  locale: string;
  input: InputOf<T, K>;
  delivery?: DeliveryOverrideFor<T, K>;
  /**
   * `'chain'` waits for the synchronous chain walk before resolving: `{ ok: true, outcome:
   * 'accepted' }` once a provider accepted the message, `{ ok: false, code: 'undelivered' }`
   * when every channel failed immediately. Without it an `otp` send resolves as soon as the
   * message is recorded, before any provider is called.
   */
  await?: 'chain';
}

/**
 * Result returned by client send.
 */
export type ClientSendResult =
  | {
      ok: true;
      id: string;
      /**
       * Present when the send was awaited (`await: 'chain'`): a provider accepted the message.
       */
      outcome?: 'accepted';
    }
  | {
      ok: false;
      status: number;
      error: string;
      /**
       * Stable failure code when the messaging Worker gave one: `undelivered` when an awaited
       * send found every channel failing immediately.
       */
      code?: string;
      /**
       * The message id, when a record was created before the failure (`undelivered`).
       */
      id?: string;
    };

/**
 * Options for creating a messaging client.
 */
export interface CreateMessagingClientOptions {
  /**
   * Service binding to the messaging Worker.
   */
  binding: Fetcher;
  /**
   * Base path of the messaging app (e.g. '/api/v1'). Default is '/'.
   */
  basePath?: string;
  /**
   * Shared secret sent in the `x-messagefall-secret` header on every request, matching the
   * messaging app's `secret` option.
   */
  secret?: string;
}

/**
 * Typed client returned by createMessagingClient.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface MessagingClient<T extends Templates<any> = Templates<any>> {
  /**
   * Send a template message.
   */
  send<K extends keyof T & string>(
    template: K,
    args: ClientSendArgs<T, K>
  ): Promise<ClientSendResult>;

  /**
   * Fetch the status record of a sent message by ID. Resolves `null` when the messaging Worker
   * has no record for that id, and throws {@link MessagingClientError} for any other non-OK
   * response, so a server fault is never mistaken for an unknown message.
   */
  status(id: string): Promise<MessageRecord | null>;
}

/**
 * Thrown by {@link MessagingClient.status} when the messaging Worker answers with anything other
 * than a record or a `404`.
 *
 * `status()` resolves `null` for "no such message" alone. Any other non-OK response — a `500`
 * from the messaging Worker, a service binding answering for a route that is not there — is a
 * fault the calling Worker has to be able to tell apart from an unknown id, so it is raised
 * rather than flattened into `null`. The message is extracted exactly as `send()` extracts the
 * one it reports on its `{ ok: false }` result.
 */
export class MessagingClientError extends Error {
  /**
   * HTTP status the messaging Worker answered with.
   */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'MessagingClientError';
    this.status = status;
  }
}

/**
 * The `error` field of a parsed JSON error body, or `undefined` when `data` isn't that shape.
 */
function parseJsonError(data: unknown): string | undefined {
  return isRecord(data) && typeof data.error === 'string' ? data.error : undefined;
}

async function tryReadText(res: { text?: () => Promise<string> }): Promise<string | undefined> {
  if (!res.text) return undefined;
  try {
    const text = await res.text();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extracts a human-readable error from a non-OK response.
 *
 * A `Response` body can only be consumed once: calling `.json()` and then falling back to
 * `.text()` on the same response throws "Body already used", so the fallback never actually
 * ran and a non-JSON error body (an HTML gateway page, a plain-text vendor error) was reported
 * as just the status text. This reads the body exactly once — as text, since that's what
 * `Response.text()` can always do — then tries to parse that text as JSON, rather than treating
 * `.json()` and `.text()` as independently retriable reads of the same stream.
 */
async function extractError(res: {
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
  statusText?: string;
  status: number;
}): Promise<string> {
  const text = await tryReadText(res);
  if (text !== undefined) {
    try {
      const jsonError = parseJsonError(JSON.parse(text));
      if (jsonError) {
        return jsonError;
      }
    } catch {
      // Not JSON: the raw text itself is the error content.
    }
    return text;
  }

  // No `text()` on this object (a caller-supplied double rather than a real `Response`): `json()`
  // is the only other way to read the body, and it is still read exactly once.
  try {
    const jsonError = parseJsonError(await res.json());
    if (jsonError) {
      return jsonError;
    }
  } catch {
    // Ignore JSON parse errors
  }

  return res.statusText || `HTTP ${res.status}`;
}

/**
 * The error of a non-OK send response, with the `code` and `id` the messaging Worker adds to an
 * `undelivered` answer. The body is read once, as {@link extractError} requires.
 */
async function extractFailure(res: Parameters<typeof extractError>[0]): Promise<{
  error: string;
  code?: string;
  id?: string;
}> {
  const text = await tryReadText(res);
  if (text === undefined) {
    return { error: await extractError(res) };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: text };
  }
  const error = parseJsonError(body) ?? text;
  if (!isRecord(body)) {
    return { error };
  }
  return {
    error,
    ...(typeof body.code === 'string' && { code: body.code }),
    ...(typeof body.id === 'string' && { id: body.id }),
  };
}

/**
 * Create a typed client for sending messages over a service binding.
 *
 * @param options - Client configuration options with Fetcher binding and optional basePath.
 * @returns A typed MessagingClient instance.
 */
export function createMessagingClient<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends Templates<any> = Templates<any>,
>(options: CreateMessagingClientOptions): MessagingClient<T> {
  const prefix = normalizeBasePath(options.basePath);
  // Kept in step with `SECRET_HEADER` in the app module, which this entry must not import (it
  // would pull in the optional `hono` peer).
  const auth: Record<string, string> =
    options.secret === undefined ? {} : { 'x-messagefall-secret': options.secret };

  return {
    async send<K extends keyof T & string>(
      template: K,
      args: ClientSendArgs<T, K>
    ): Promise<ClientSendResult> {
      const body: Record<string, unknown> = {
        template,
        to: args.to,
        locale: args.locale,
        input: args.input,
      };
      if (args.email !== undefined) {
        body.email = args.email;
      }
      if (args.delivery !== undefined) {
        body.delivery = args.delivery;
      }
      if (args.await !== undefined) {
        body.await = args.await;
      }

      const res = await options.binding.fetch(`https://messaging${prefix}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data = await res.json<{ id: string; outcome?: 'accepted' }>();
        return data.outcome === undefined
          ? { ok: true, id: data.id }
          : { ok: true, id: data.id, outcome: data.outcome };
      }

      return { ok: false, status: res.status, ...(await extractFailure(res)) };
    },

    async status(id: string): Promise<MessageRecord | null> {
      // Encoded even though the ids this package mints are ULIDs, which need no escaping: the
      // id is whatever the caller passes, and a `/` or `?` in it would otherwise address a
      // different route.
      const res = await options.binding.fetch(
        `https://messaging${prefix}/status/${encodeURIComponent(id)}`,
        { method: 'GET', headers: auth }
      );

      if (res.status === 404) {
        return null;
      }

      if (!res.ok) {
        throw new MessagingClientError(res.status, await extractError(res));
      }

      const record = await res.json<MessageRecord>();
      return record;
    },
  };
}
