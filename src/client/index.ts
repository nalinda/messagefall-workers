/**
 * createMessagingClient
 *
 * Create a typed client for sending messages over service bindings.
 *
 * @module
 */

import type { Fetcher } from '@cloudflare/workers-types';

import type { MessageRecord } from '../core/status.js';
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
}

/**
 * Result returned by client send.
 */
export type ClientSendResult =
  { ok: true; id: string } | { ok: false; status: number; error: string };

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
}

/**
 * Alias for CreateMessagingClientOptions.
 */
export type MessagingClientOptions = CreateMessagingClientOptions;

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
   * Fetch the status record of a sent message by ID.
   */
  status(id: string): Promise<MessageRecord | null>;
}

function normalizeBasePath(basePath?: string): string {
  if (!basePath) return '';
  const trimmed = basePath.trim();
  const withoutLeading = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  const withoutTrailing = withoutLeading.endsWith('/')
    ? withoutLeading.slice(0, -1)
    : withoutLeading;
  return withoutTrailing ? `/${withoutTrailing}` : '';
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null;
}

async function tryParseJsonError(res: {
  json: () => Promise<unknown>;
}): Promise<string | undefined> {
  try {
    const data = await res.json();
    if (isRecord(data) && typeof data.error === 'string') {
      return data.error;
    }
  } catch {
    // Ignore JSON parse errors
  }
  return undefined;
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

async function extractError(res: {
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
  statusText?: string;
  status: number;
}): Promise<string> {
  const jsonError = await tryParseJsonError(res);
  if (jsonError) {
    return jsonError;
  }

  const text = await tryReadText(res);
  if (text) {
    return text;
  }

  return res.statusText || `HTTP ${res.status}`;
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

      const res = await options.binding.fetch(`https://messaging${prefix}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data = await res.json<{ id: string }>();
        return { ok: true, id: data.id };
      }

      const error = await extractError(res);
      return {
        ok: false,
        status: res.status,
        error,
      };
    },

    async status(id: string): Promise<MessageRecord | null> {
      const res = await options.binding.fetch(`https://messaging${prefix}/status/${id}`, {
        method: 'GET',
      });

      if (res.status === 404) {
        return null;
      }

      if (!res.ok) {
        return null;
      }

      const record = await res.json<MessageRecord>();
      return record;
    },
  };
}
