/**
 * Webhook dispatch: routes /webhooks/:provider to the provider's handler,
 * applies delivery status updates to the status store, and drives fallback.
 *
 * @module
 */

import type { ExecutionContext, KVNamespace } from '@cloudflare/workers-types';

import type { Channel, Provider, StatusEvent } from '../providers/types.js';
import type { Templates } from '../templates.js';
import { createLogger } from './logger.js';
import { extractTemplateSensitiveStrings, scrubError } from './redact.js';
import { asRenderInput, renderInputKey } from './render-input.js';
import type { ProviderSet } from './send.js';
import {
  type Attempt,
  chainStatus,
  deriveOverallStatus,
  isConfirmedDelivery,
  kvStatusStore,
  type MessageRecord,
  type ProviderRef,
  type StatusStore,
} from './status.js';

const logger = createLogger();

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
  /**
   * The template catalogue — the resolved `MessagingOptions.templates` — used to recover the
   * rendered content a vendor error might otherwise echo back, when only the template name (not
   * a `keyof T`) is known. See {@link extractTemplateSensitiveStrings}.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  templates?: Templates<any>;
  /**
   * Called with each parsed status event. When the event was matched to a message (a store is
   * configured and the providerId is indexed) the resolved `ProviderRef` is passed as well.
   */
  onStatus?: (event: StatusEvent, ref?: ProviderRef) => void | Promise<void>;
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
 * The hostnames the dev bypass treats as loopback. `[::1]` is the spelling `URL` reports for the
 * IPv6 loopback — brackets included — which is what `wrangler dev` hands the Worker when it is
 * reached over IPv6.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Checks whether the development bypass (MESSAGING_DEV_UNSIGNED) is permitted
 * for the incoming request. Bypass is strictly permitted only on a loopback host.
 */
function isDevBypassAllowed(request: Request, env?: Record<string, unknown>): boolean {
  if (!env || env.MESSAGING_DEV_UNSIGNED !== 'true') {
    return false;
  }
  try {
    const url = new URL(request.url);
    const hostname = url.hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(hostname);
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
 * Whether an incoming status event should overwrite the attempt's recorded status.
 *
 * Vendors redeliver and reorder callbacks, so an event is not automatically the latest word about
 * an attempt, and its timestamp is not a tie-break either: a redelivery carries the timestamp it
 * always had, and a vendor clock is not ours. The only thing that decides is which transitions
 * the delivery lifecycle actually permits, per current status:
 *
 * - `sent` — the attempt is still in flight, so every outcome is genuine progress:
 *   `delivered`, `read` and `failed` are all applied.
 * - `delivered` — the message reached the recipient. Permanently terminal apart from `read`,
 *   which is the one thing that can still happen to a delivered message. A later `failed` is
 *   NOT applied: accepting it would rewrite a delivered attempt to `failed`, re-derive the
 *   chain back to non-terminal and let the fallback walk dispatch the next channel — sending an
 *   already-delivered message (an OTP code, say) a second time on another channel.
 * - `read` — permanently terminal; nothing is applied over it.
 * - `failed` — upgradable by a late `delivered`/`read`. DECISION: these upgrades ARE accepted.
 *   A confirmation arriving after a timeout or a vendor's own failure callback is real news
 *   about the same attempt, and recording it costs nothing: by the time it lands the fallback
 *   chain has already been walked, and `shouldSkipAdvancement` reads a `delivered`/`read` chain
 *   as finished, so the upgrade can only stop further sends, never cause one. A `sent` after
 *   `failed` is rejected — that is a rewind, not news.
 *
 * A repeat of the status already recorded is a silent no-op rather than a rejection: nothing
 * about the attempt changed, so no side effect (log, `onStatusApplied`, fallback) should fire.
 */
function isStatusProgression(att: Attempt, event: StatusEvent): boolean {
  if (event.status === att.status) {
    return false;
  }
  switch (att.status) {
    case 'sent': {
      return true;
    }
    case 'delivered': {
      return event.status === 'read';
    }
    case 'read': {
      return false;
    }
    case 'failed': {
      return isConfirmedDelivery(event.status);
    }
  }
}

/**
 * Whether `att` is the attempt a status event/reference is about.
 *
 * A provider id is only unique inside its own vendor's id space, so the provider is part of the
 * identity, never the bare id alone: several attempts on one message can carry the same
 * `providerId` (the console provider mints `console_<messageId>` on every channel, and two real
 * vendors can collide by coincidence). Matching on the id alone let a status event for one
 * channel's attempt overwrite an unrelated attempt on another — including an always-on channel's
 * webhook rewriting a chain attempt and driving a bogus fallback advance, which the always-on
 * contract forbids outright.
 *
 * So the provider must match, and then either the attempt already carries the event's own
 * `providerId`, or it is the attempt on the channel the reference resolved to (the only match
 * available before an attempt has a `providerId` indexed at all).
 */
function isMatchingAttempt(att: Attempt, event: StatusEvent, ref: ProviderRef): boolean {
  if (att.provider !== ref.provider) {
    return false;
  }
  return att.providerId === event.providerId || att.channel === ref.channel;
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

/**
 * Resolves the sensitive strings to scrub from an event's error message.
 *
 * Only called when the event actually carries an `error` — the KV read here (and the
 * `existingRecord` lookup at the call site) exist solely to feed this scrub, so skipping the call
 * for the common `sent`/`delivered`/`read` case (no error) saves them entirely.
 */
async function resolveWebhookSensitive(
  options: WebhookDispatchOptions,
  refId: string,
  existingRecord: MessageRecord | null,
  error: string
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

  if (existingRecord && options.templates) {
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
  providerName: string,
  store: StatusStore,
  options: WebhookDispatchOptions
): Promise<{ wasHandled: boolean }> {
  // Scoped to the provider the webhook arrived for: the same bare id can belong to a different
  // attempt of the same message under another provider. See `StatusStore.indexProviderId`.
  const ref = await store.lookupProviderId(event.providerId, providerName);
  if (!ref) {
    return { wasHandled: false };
  }

  // The KV reads behind this are only needed to scrub `event.error` — for a normal
  // `sent`/`delivered`/`read` callback (no error) there is nothing to scrub, so both the
  // render-input read and this record lookup are skipped, letting `store.update`'s own read
  // below serve the update instead of a separate preceding one.
  let scrubbedEvent: StatusEvent = event;
  if (event.error !== undefined) {
    const existingRecord = await store.get(ref.id);
    const sensitive = await resolveWebhookSensitive(options, ref.id, existingRecord, event.error);
    scrubbedEvent = { ...event, error: scrubError(event.error, sensitive) };
  }

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

  // Only when the event actually moved the attempt forward: a redelivered or out-of-order event
  // `applyStatusUpdate` dropped changed nothing, and logging it as applied would tell an
  // operator a status changed when it did not.
  if (applied.hasChanged) {
    logger.info('webhook.applied', {
      id: ref.id,
      channel: ref.channel,
      provider: ref.provider,
      status: scrubbedEvent.status,
    });
  }

  // Gated on `hasChanged` for the same reason the log line above is: `onStatus` is documented as
  // being called on every status *change*, so a vendor redelivering one `failed` callback five
  // times must not be reported to the caller's observer five times over. An event
  // `applyStatusUpdate` dropped — a redelivery, a rewind, an overwrite of a terminal outcome —
  // changed nothing about the message, and there is nothing to observe.
  if (applied.hasChanged && options.onStatus) {
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
  providerName: string,
  store: StatusStore | null,
  options: WebhookDispatchOptions
): Promise<{ wasHandled: boolean }> {
  if (store) {
    return handleSingleEvent(event, providerName, store, options);
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
 * @param providerName - Name of the provider the events came from. It scopes the provider-id
 *   lookup to that provider's own id space (and labels the unmatched-event log).
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
      const { wasHandled } = await applyOneEvent(event, providerName, store, options);
      if (!wasHandled) {
        unknownCount++;
      }
    } catch (error) {
      logger.error('webhook.event-failed', {
        provider: providerName,
        providerId: event.providerId,
        errorCode: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  if (unknownCount > 0) {
    logger.warn('webhook.received', {
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
