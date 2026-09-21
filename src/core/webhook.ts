/**
 * Webhook dispatch: routes /webhooks/:provider to the provider's handler,
 * applies delivery status updates to the status store, and drives fallback.
 *
 * @module
 */

import type { ExecutionContext, KVNamespace } from '@cloudflare/workers-types';

import type { Channel, Provider, StatusEvent } from '../providers/types.js';
import { createLogger } from './logger.js';
import { extractTemplateSensitiveStrings, scrubError } from './redact.js';
import { asRenderInput, renderInputKey } from './render-input.js';
import {
  type Attempt,
  deriveOverallStatus,
  kvStatusStore,
  type MessageRecord,
  type ProviderRef,
  type StatusStore,
} from './status.js';

const defaultLogger = createLogger();

/**
 * Event emitted when a delivery status update is applied to an attempt.
 * Consumed by fallback handler (#7) and timer cancel path (#8).
 */
export interface StatusApplied {
  /**
   * Internal message identifier.
   */
  id: string;
  /**
   * Delivery channel of the attempt.
   */
  channel: Channel;
  /**
   * Name of the provider handling the attempt.
   */
  provider: string;
  /**
   * Part of the delivery policy ('chain' for fallback chain, 'always' for parallel always-on).
   */
  part: 'chain' | 'always';
  /**
   * Parsed delivery status event.
   */
  event: StatusEvent;
  /**
   * The record as written with this status applied, so consumers can act on its policy without
   * a second read.
   */
  record: MessageRecord;
}

/**
 * Webhook dispatch configuration options.
 */
export interface WebhookDispatchOptions {
  providers?:
    | Record<string, Provider>
    | Provider[]
    | Map<string, Provider>
    | ((env: unknown) => Record<string, Provider>);
  kv?: KVNamespace;
  store?: StatusStore;
  templates?: unknown;
  /**
   * Called with each parsed status event. When the event was matched to a message (a store is
   * configured and the providerId is indexed) the resolved `ProviderRef` is passed as well.
   */
  onStatus?: (event: unknown, ref?: ProviderRef) => void | Promise<void>;
  onStatusApplied?: (event: StatusApplied) => void | Promise<void>;
  env?: Record<string, unknown>;
}

/**
 * Webhook handler function signature.
 */
export type WebhookHandler = (
  providerName: string,
  request: Request,
  ctx?: ExecutionContext
) => Promise<Response>;

/**
 * Checks whether the development bypass (MESSAGING_DEV_UNSIGNED) is permitted
 * for the incoming request. Bypass is strictly permitted only on localhost or 127.0.0.1.
 */
function isDevBypassAllowed(request: Request, env?: Record<string, unknown>): boolean {
  if (!env || env.MESSAGING_DEV_UNSIGNED !== 'true') {
    return false;
  }
  try {
    const url = new URL(request.url);
    const hostname = url.hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Resolves a provider by its name from the configured providers.
 */
function findProvider(
  providers: WebhookDispatchOptions['providers'],
  providerName: string,
  env?: Record<string, unknown>
): Provider | null {
  if (!providers) return null;
  const resolved = typeof providers === 'function' ? providers(env) : providers;
  if (resolved instanceof Map) {
    for (const provider of resolved.values()) {
      if (provider.name === providerName) {
        return provider;
      }
    }
    return null;
  }
  if (Array.isArray(resolved)) {
    return resolved.find((p) => p.name === providerName) ?? null;
  }
  return Object.values(resolved).find((p) => p.name === providerName) ?? null;
}

/**
 * Resolves the status store from options, explicit kv, or environment bindings.
 */
function resolveStatusStore(options: WebhookDispatchOptions): StatusStore | null {
  if (options.store) {
    return options.store;
  }
  if (options.kv) {
    return kvStatusStore(options.kv);
  }
  const envKv = options.env?.MESSAGES_KV as KVNamespace | undefined;
  if (envKv) {
    return kvStatusStore(envKv);
  }
  return null;
}

/**
 * Updates a single attempt if it matches the event and provider reference.
 */
function updateAttempt(att: Attempt, event: StatusEvent, ref: ProviderRef): Attempt {
  const hasMatched =
    att.providerId === event.providerId ||
    (att.channel === ref.channel && att.provider === ref.provider);

  if (!hasMatched) {
    return att;
  }

  const updated: Attempt = {
    ...att,
    providerId: att.providerId ?? event.providerId,
    status: event.status,
    at: event.at,
  };
  if (event.error !== undefined) {
    updated.error = event.error;
  }
  return updated;
}

/**
 * Applies a delivery status event to a MessageRecord.
 */
function applyStatusUpdate(
  record: MessageRecord,
  event: StatusEvent,
  ref: ProviderRef
): { updatedRecord: MessageRecord; isChain: boolean } {
  const isChain = record.chain.attempts.some(
    (att) =>
      att.providerId === event.providerId ||
      (att.channel === ref.channel && att.provider === ref.provider)
  );

  const chainAttempts = record.chain.attempts.map((att) => updateAttempt(att, event, ref));
  const alwaysAttempts = record.always.map((att) => updateAttempt(att, event, ref));

  const latestAttempt = chainAttempts.at(-1);
  const newChainStatus = latestAttempt ? latestAttempt.status : record.chain.status;

  const newOverallStatus = deriveOverallStatus(
    record.policy,
    { status: newChainStatus, attempts: chainAttempts },
    alwaysAttempts
  );

  const updatedRecord: MessageRecord = {
    ...record,
    chain: {
      status: newChainStatus,
      attempts: chainAttempts,
    },
    always: alwaysAttempts,
    status: newOverallStatus,
    updatedAt: event.at,
  };

  return { updatedRecord, isChain };
}

async function resolveWebhookSensitive(
  options: WebhookDispatchOptions,
  refId: string,
  existingRecord: MessageRecord | null,
  error?: string
): Promise<unknown[]> {
  const sensitive: unknown[] = [];
  const kv = options.kv ?? (options.env?.MESSAGES_KV as KVNamespace | undefined);
  if (kv) {
    try {
      const rawInput = await kv.get(renderInputKey(refId));
      if (rawInput) {
        // Only the template input's own field values, not the envelope's `to` / `email` /
        // `locale` around them: those cannot leak the message content, and scrubbing an error
        // for short metadata values shreds ordinary vendor error strings.
        sensitive.push(asRenderInput(JSON.parse(rawInput) as unknown).input);
      }
    } catch {
      // ignore
    }
  }

  if (error && existingRecord && options.templates) {
    sensitive.push(
      ...extractTemplateSensitiveStrings(options.templates, existingRecord.template, error)
    );
  }

  return sensitive;
}

/**
 * Handles a single status event against the store and callbacks.
 */
async function handleSingleEvent(
  event: StatusEvent,
  store: StatusStore,
  options: WebhookDispatchOptions
): Promise<{ wasHandled: boolean }> {
  const ref = await store.lookupProviderId(event.providerId);
  if (!ref) {
    return { wasHandled: false };
  }

  const existingRecord = await store.get(ref.id);
  const isChain = existingRecord
    ? existingRecord.chain.attempts.some(
        (att) =>
          att.providerId === event.providerId ||
          (att.channel === ref.channel && att.provider === ref.provider)
      )
    : false;

  const sensitive = await resolveWebhookSensitive(options, ref.id, existingRecord, event.error);
  const scrubbedEvent: StatusEvent =
    event.error === undefined ? event : { ...event, error: scrubError(event.error, sensitive) };

  const updatedRecord = await store.update(
    ref.id,
    (record) => applyStatusUpdate(record, scrubbedEvent, ref).updatedRecord
  );

  if (options.onStatus) {
    await options.onStatus(scrubbedEvent, ref);
  }

  if (isChain && options.onStatusApplied) {
    await options.onStatusApplied({
      id: ref.id,
      channel: ref.channel,
      provider: ref.provider,
      part: 'chain',
      event: scrubbedEvent,
      record: updatedRecord,
    });
  }

  return { wasHandled: true };
}

/**
 * Applies a batch of parsed status events: matches each one to its message, writes it to the
 * record and fires `onStatus` / `onStatusApplied`.
 *
 * This is the one place a delivery status is turned into a record update. The webhook dispatcher
 * below calls it for a parsed request body, and `createMessaging` calls it for a provider's
 * simulated statuses (the console provider's `simulate` option), so a simulated `delivered` or
 * `failed` takes exactly the path a real vendor callback takes — including driving fallback.
 *
 * @param events - The parsed status events.
 * @param providerName - Name of the provider the events came from, for the unmatched-event log.
 * @param options - Webhook dispatch configuration options.
 */
export async function applyStatusEvents(
  events: StatusEvent[],
  providerName: string,
  options: WebhookDispatchOptions
): Promise<void> {
  const store = resolveStatusStore(options);
  let unknownCount = 0;

  for (const event of events) {
    if (store) {
      const result = await handleSingleEvent(event, store, options);
      if (!result.wasHandled) {
        unknownCount++;
      }
    } else if (options.onStatus) {
      await options.onStatus(event);
    }
  }

  if (unknownCount > 0) {
    defaultLogger.warn('webhook.received', {
      count: unknownCount,
      provider: providerName,
    });
  }
}

/**
 * Creates a webhook handler for dispatching webhook requests to provider handlers.
 *
 * @param options - Webhook dispatch configuration options.
 * @returns WebhookHandler function.
 */
export function createWebhookHandler(options: WebhookDispatchOptions): WebhookHandler {
  return async (
    providerName: string,
    request: Request,
    ctx?: ExecutionContext
  ): Promise<Response> => {
    const provider = findProvider(options.providers, providerName, options.env);
    if (!provider || !provider.webhook) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    if (typeof provider.webhook.verify === 'function') {
      const verifyResponse = await provider.webhook.verify(request);
      if (verifyResponse !== null) {
        return verifyResponse;
      }
    }

    const isDevUnsigned = isDevBypassAllowed(request, options.env);
    let events: StatusEvent[];
    try {
      events = await provider.webhook.parse(request, { devUnsigned: isDevUnsigned });
    } catch {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const parsedEvents = Array.isArray(events) ? events : [];

    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(applyStatusEvents(parsedEvents, providerName, options));
    } else {
      await applyStatusEvents(parsedEvents, providerName, options);
    }

    return new Response('OK', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  };
}

/**
 * Dispatches a webhook request to the designated provider handler.
 *
 * @param providerName - Name of the provider.
 * @param request - Incoming HTTP Request.
 * @param ctx - Cloudflare ExecutionContext if available.
 * @param options - Webhook dispatch configuration options.
 * @returns HTTP Response.
 */
export async function handleWebhook(
  providerName: string,
  request: Request,
  ctx?: ExecutionContext,
  options?: WebhookDispatchOptions
): Promise<Response> {
  const handler = createWebhookHandler(options ?? {});
  return handler(providerName, request, ctx);
}
