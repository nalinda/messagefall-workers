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
import type { ProviderSet } from './send.js';
import {
  type Attempt,
  chainStatus,
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
  /**
   * The providers, keyed by channel slot — the resolved `ProviderSet` `createMessaging` builds
   * from `MessagingOptions.providers`, which is the one shape the public API produces.
   */
  providers?: ProviderSet;
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
 *
 * The set is keyed by channel slot, but a webhook arrives for a provider *name*, so the lookup
 * is over the values rather than the keys.
 */
function findProvider(
  providers: WebhookDispatchOptions['providers'],
  providerName: string
): Provider | null {
  if (!providers) return null;
  const slots: (Provider | undefined)[] = [providers.whatsapp, providers.sms, providers.email];
  return slots.find((p) => p?.name === providerName) ?? null;
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
 * How far along its lifecycle a delivery status is: an attempt goes out `sent`, then either
 * climbs to `delivered` and `read` or ends `failed`.
 *
 * This is deliberately NOT `status.ts`'s `failed < sent < delivered < read`. That ordering ranks
 * statuses by severity, to take the worst of the always attempts; this one ranks them by the
 * order they actually arrive in, so `failed` — a terminal outcome that by definition follows
 * `sent` — counts as progress rather than as a rewind.
 */
function lifecycleRank(status: StatusEvent['status']): number {
  switch (status) {
    case 'sent': {
      return 0;
    }
    case 'delivered': {
      return 1;
    }
    case 'read': {
      return 2;
    }
    case 'failed': {
      return 3;
    }
  }
}

/**
 * Whether an incoming status event should overwrite the attempt's recorded status.
 *
 * Vendors redeliver and reorder callbacks, so an event is not automatically the latest word about
 * an attempt. One is applied when it moves the attempt forward through the lifecycle, or when it
 * is genuinely newer than what is recorded. A `sent` redelivered after a `delivered` satisfies
 * neither — it would otherwise rewind the attempt, the chain and the overall status to `sent`
 * permanently, since nothing later would come along to correct it.
 */
function isStatusProgression(att: Attempt, event: StatusEvent): boolean {
  return lifecycleRank(event.status) > lifecycleRank(att.status) || event.at > att.at;
}

/**
 * Whether `att` is the attempt a status event/reference is about: either it already carries the
 * event's own `providerId`, or it is the attempt on the same channel and provider the reference
 * resolved to (the only match available before an attempt has a `providerId` indexed at all).
 */
function isMatchingAttempt(att: Attempt, event: StatusEvent, ref: ProviderRef): boolean {
  return (
    att.providerId === event.providerId ||
    (att.channel === ref.channel && att.provider === ref.provider)
  );
}

/**
 * Updates a single attempt if it matches the event and provider reference.
 */
function updateAttempt(att: Attempt, event: StatusEvent, ref: ProviderRef): Attempt {
  if (!isMatchingAttempt(att, event, ref) || !isStatusProgression(att, event)) {
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
 *
 * The chain's status is re-derived with `chainStatus` — the same function the send pipeline's
 * recorder uses — rather than taken from the latest attempt's raw status, so a `failed` webhook
 * for a chain with fallback channels still to try leaves the chain `pending` until the walk has
 * actually exhausted them.
 */
function applyStatusUpdate(
  record: MessageRecord,
  event: StatusEvent,
  ref: ProviderRef
): { updatedRecord: MessageRecord; isChain: boolean; hasChanged: boolean } {
  const isChain = record.chain.attempts.some((att) => isMatchingAttempt(att, event, ref));

  const chainAttempts = record.chain.attempts.map((att) => updateAttempt(att, event, ref));
  const alwaysAttempts = record.always.map((att) => updateAttempt(att, event, ref));
  // `updateAttempt` returns the attempt itself when it leaves it alone, so identity is the test.
  const hasChanged =
    chainAttempts.some((att, index) => att !== record.chain.attempts.at(index)) ||
    alwaysAttempts.some((att, index) => att !== record.always.at(index));

  const newChainStatus =
    chainAttempts.length > 0
      ? chainStatus(chainAttempts, record.policy.fallback)
      : record.chain.status;

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
    // A dropped event (a redelivery, or one that arrived out of order) changed nothing, so it
    // must not move `updatedAt` either.
    updatedAt: hasChanged ? event.at : record.updatedAt,
  };

  return { updatedRecord, isChain, hasChanged };
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
  const sensitive = await resolveWebhookSensitive(options, ref.id, existingRecord, event.error);
  const scrubbedEvent: StatusEvent =
    event.error === undefined ? event : { ...event, error: scrubError(event.error, sensitive) };

  // Captured from `applyStatusUpdate`'s own result rather than recomputed from `existingRecord`:
  // that keeps this one match against the actual write, not a second guess at what it did. A
  // plain object, not two `let` bindings: a `let` reassigned only inside the updater closure is
  // never narrowed away from its initial value at the read below, which the linter (correctly,
  // by the rules of control-flow analysis) then flags as dead.
  const applied = { isChain: false, hasChanged: false };
  const updatedRecord = await store.update(ref.id, (record) => {
    const result = applyStatusUpdate(record, scrubbedEvent, ref);
    applied.isChain = result.isChain;
    applied.hasChanged = result.hasChanged;
    return result.updatedRecord;
  });

  if (options.onStatus) {
    await options.onStatus(scrubbedEvent, ref);
  }

  // A redelivered or out-of-order event that `applyStatusUpdate` dropped (see `hasChanged`
  // there) changed nothing about the record, so it must not drive fallback or a terminal-state
  // release a second time either: without this, a redelivered terminal webhook re-seals the
  // chain and fires `onStatus` again for the same failure every time the vendor retries it.
  if (applied.isChain && applied.hasChanged && options.onStatusApplied) {
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
 * Applies one event: to the store when there is one, otherwise straight to `onStatus`.
 */
async function applyOneEvent(
  event: StatusEvent,
  store: StatusStore | null,
  options: WebhookDispatchOptions
): Promise<{ wasHandled: boolean }> {
  if (store) {
    return handleSingleEvent(event, store, options);
  }
  if (options.onStatus) {
    await options.onStatus(event);
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
    // Applying one event must never sink the batch or the response. The handler answers `200` as
    // soon as the body parses — vendors retry on anything else, and a retry cannot fix an expired
    // record, a KV fault or a throwing `onStatusApplied`. So every per-event failure is logged and
    // the next event is tried, on the inline path exactly as on the `ctx.waitUntil` one.
    try {
      const { wasHandled } = await applyOneEvent(event, store, options);
      if (!wasHandled) {
        unknownCount++;
      }
    } catch (error) {
      defaultLogger.error('webhook.event-failed', {
        provider: providerName,
        providerId: event.providerId,
        errorCode: error instanceof Error ? error.name : 'UnknownError',
      });
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
    const provider = findProvider(options.providers, providerName);
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
