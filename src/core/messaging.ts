/**
 * createMessaging: builds providers and the status store per env and exposes send/status.
 *
 * @module
 */

import type { DurableObjectNamespace, KVNamespace } from '@cloudflare/workers-types';

import type { MessagingEnv } from '../env.js';
import type { StatusEvent } from '../providers/types.js';
import type { InputOf, TemplateDef, Templates } from '../templates.js';
import { withAdvanceLock } from './advance-lock.js';
import { advanceChain } from './fallback.js';
import { DEFAULT_POLICY, type DeliveryOverride, type DeliveryPolicy } from './policy.js';
import { validateProviderSet } from './provider-set.js';
import { releaseChain } from './render-input.js';
import {
  notifyStatus,
  type ProviderSet,
  runSend,
  type SendContext,
  type StatusCallbackEvent,
} from './send.js';
import {
  DEFAULT_STATUS_TTL,
  isTerminalChainStatus,
  kvStatusStore,
  type MessageRecord,
  type StatusStore,
} from './status.js';
import {
  announceTimerOff,
  type FallbackTimerClient,
  registerMessagingOptions,
  resolveTimer,
} from './timer.js';
import { applyStatusEvents, createWebhookHandler, type WebhookDispatchOptions } from './webhook.js';

export { ProviderConfigError } from './provider-set.js';
export type { ProviderSet, SendContext, StatusCallbackEvent } from './send.js';
export { E164, EmailRecipientError, isEmailAddress, RecipientError } from './send.js';

/**
 * Options accepted by createMessaging.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface MessagingOptions<T extends Templates<any> = Templates<any>> {
  templates: T;
  providers: (env: MessagingEnv) => ProviderSet;
  delivery?: Partial<DeliveryPolicy> & { timeout?: { otp?: number; notification?: number } };
  kv?: KVNamespace;
  timer?: DurableObjectNamespace;
  statusTtl?: number;
  onStatus?: (event: StatusCallbackEvent) => void | Promise<void>;
}

/**
 * Arguments to Messaging#send.
 */
export interface SendArgs<T, K extends keyof T> {
  template: K;
  to: string;
  email?: string;
  locale: string;
  input: InputOf<T, K>;
  delivery?: DeliveryOverride;
}

/**
 * Messaging instance returned by createMessaging.
 */
export interface Messaging<T> {
  send<K extends keyof T>(args: SendArgs<T, K>, ctx?: SendContext): Promise<{ id: string }>;
  status(id: string): Promise<MessageRecord | null>;
  /**
   * Handles a provider's delivery-status webhook (#5): 404 for an unknown provider or one
   * without a webhook, 401 for a rejected payload, 200 once the status events are applied.
   */
  handleWebhook(provider: string, request: Request, ctx?: SendContext): Promise<Response>;
}

/**
 * Thrown by createMessaging for a deployment/configuration fault (no KV namespace for the
 * status store).
 */
export class MessagingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessagingConfigError';
  }
}

/**
 * Rejected by `send` when the template name is not in the catalogue: a per-call input fault,
 * distinct from configuration errors so callers can map it to a 4xx.
 */
export class UnknownTemplateError extends Error {
  readonly templateName: string;

  constructor(templateName: string) {
    super(`Unknown template "${templateName}"`);
    this.name = 'UnknownTemplateError';
    this.templateName = templateName;
  }
}

type ProviderFactory = (env: MessagingEnv) => ProviderSet;

const providerCache = new WeakMap<MessagingEnv, ProviderSet>();

/**
 * Deliberately keyed on the KV namespace (then TTL), not on `env`: `options.kv` may differ from
 * `env.MESSAGES_KV`, and two envs sharing a namespace should share the store. Reuse this cache;
 * do not add an `env`-keyed one.
 */
const storeCache = new WeakMap<KVNamespace, Map<number, StatusStore>>();

/**
 * Memoised on `env` alone: within an isolate `env` is stable across requests, so an inline
 * factory closure created per request still hits the cache.
 */
function memoProviders(env: MessagingEnv, build: ProviderFactory): ProviderSet {
  let set = providerCache.get(env);
  if (!set) {
    set = build(env);
    validateProviderSet(set);
    providerCache.set(env, set);
  }
  return set;
}

function memoStore(kv: KVNamespace, ttlSeconds: number): StatusStore {
  let byTtl = storeCache.get(kv);
  if (!byTtl) {
    byTtl = new Map();
    storeCache.set(kv, byTtl);
  }
  let store = byTtl.get(ttlSeconds);
  if (!store) {
    store = kvStatusStore(kv, { ttlSeconds });
    byTtl.set(ttlSeconds, store);
  }
  return store;
}

/**
 * What the asynchronous fallback path needs to advance one chain, beyond the messaging options
 * themselves: which message, why, and (from the timer) the input it stored.
 *
 * Internal seam for the `./durable` entry (imported by relative path); deliberately not part of
 * the root barrel's public surface, together with {@link advanceChainFor} and
 * {@link statusStoreFor}.
 */
export interface AdvanceChainRequest {
  /**
   * Internal message identifier.
   */
  id: string;
  /**
   * `failed` from a delivery status, `timeout` from the fallback timer's alarm.
   */
  reason: 'failed' | 'timeout';
  /**
   * Render input pass-through (the timer's stored state); the `in:<id>` KV entry fills in the
   * recipient when it is absent here.
   */
  input?: unknown;
  /**
   * Timer override for this advance. The Durable Object passes itself so a re-arm from inside
   * its own alarm is a direct storage write rather than a request to its own stub.
   */
  timer?: FallbackTimerClient;
}

/**
 * Advances a message's fallback chain with the core rebuilt from `options` for `env`: providers,
 * status store and timer resolved exactly as `createMessaging` resolves them. This is the entry
 * the `delivered` / `failed` webhook bridge and the `FallbackTimer` Durable Object share, so the
 * asynchronous path and the request path cannot drift apart.
 *
 * Advances for one message are serialized through {@link withAdvanceLock}, so a redelivered
 * `failed` webhook cannot walk the chain twice and put two sends on the next channel.
 *
 * @param env - Worker bindings.
 * @param options - The messaging options the Worker was configured with.
 * @param request - Which chain to advance and why.
 * @throws {MessagingConfigError} If no KV namespace is available.
 */
export async function advanceChainFor<T extends Templates<Record<string, TemplateDef<unknown>>>>(
  env: MessagingEnv,
  options: MessagingOptions<T>,
  request: AdvanceChainRequest
): Promise<void> {
  const kv = requireKv(env, options);
  const { providers } = wiredCore(env, options, kv);
  const store = statusStoreFor(env, options);
  await withAdvanceLock(kv, request.id, () =>
    advanceChain({
      id: request.id,
      reason: request.reason,
      env,
      options: {
        templates: options.templates,
        providers,
        onStatus: options.onStatus,
        delivery: options.delivery,
        kv,
        timer: request.timer ?? resolveTimer(env, options.timer),
      },
      store,
      ...(request.input !== undefined && { input: request.input }),
    })
  );
}

async function handleChainStatusApplied<T extends Templates<Record<string, TemplateDef<unknown>>>>(
  id: string,
  event: StatusEvent,
  record: MessageRecord,
  env: MessagingEnv,
  options: MessagingOptions<T>,
  kv: KVNamespace
): Promise<void> {
  if (event.status === 'failed') {
    // A chain some attempt has already confirmed `delivered` / `read` never falls back again:
    // `shouldSkipAdvancement` no-ops on exactly that, but only after a full advance-lease round
    // trip (KV get + put + delete) and a record read. Decide it here from the record this event
    // was just applied to and skip the trip. Only confirmed delivery is skippable, not every
    // terminal status: a `failed` that exhausts the last fallback channel makes the chain
    // terminal-failed for the first time, and it is this advance that seals, notifies and
    // releases it.
    if (record.chain.status !== 'delivered' && record.chain.status !== 'read') {
      await advanceChainFor(env, options, { id, reason: 'failed' });
    }
    return;
  }

  // Terminality is read off the record this event was just applied to, never off the event
  // itself. The two genuinely differ: a `delivered` callback for a superseded earlier channel is
  // a real late upgrade of that attempt (see `isStatusProgression`), but it is `chainStatus` —
  // which weighs every attempt, not just the triggering one — that decides whether the chain as a
  // whole is finished. Releasing on the event alone would tear down the fallback timer and the
  // stored render input of a chain that is still `pending` with channels left to try, leaving a
  // later failure with nothing to rebuild the next attempt from.
  if (isTerminalChainStatus(record.chain.status)) {
    // The chain is terminal: nothing is left to fall back to, so drop the timer (if this chain
    // ever armed one) and the input.
    await releaseChain(resolveTimer(env, options.timer), kv, id, record.policy.fallback);
  }
}

function requireKv(env: MessagingEnv, options: { kv?: KVNamespace }): KVNamespace {
  const kv = options.kv ?? (env as Partial<MessagingEnv>).MESSAGES_KV;
  if (!kv) {
    throw new MessagingConfigError('createMessaging needs options.kv or env.MESSAGES_KV');
  }
  return kv;
}

/**
 * The status store `createMessaging` would use for `env` and `options`: `options.kv` else
 * `env.MESSAGES_KV`, memoised per namespace and TTL. The one resolution every path shares —
 * the request path, the webhook bridge and the `FallbackTimer` Durable Object — so a missing
 * namespace fails identically everywhere.
 *
 * @param env - Worker bindings.
 * @param options - The messaging options the Worker was configured with.
 * @returns The status store.
 * @throws {MessagingConfigError} If no KV namespace is available.
 */
export function statusStoreFor(
  env: MessagingEnv,
  options: { kv?: KVNamespace; statusTtl?: number }
): StatusStore {
  return memoStore(requireKv(env, options), options.statusTtl ?? DEFAULT_STATUS_TTL);
}

/**
 * Routes a provider's simulated delivery statuses through the webhook path.
 *
 * A provider that fakes statuses locally — the console provider's `simulate` option — fires them
 * on `onSimulatedStatus`. Nothing else in the core assigns that hook, so without this the
 * simulated `delivered` / `failed` was dropped on the floor: it never reached the status store,
 * never called `onStatus` and never drove fallback, even though the README's local-development
 * section advertises exactly that.
 *
 * The hook is deliberately wired to {@link applyStatusEvents}, the same function the webhook
 * dispatcher hands a parsed vendor payload to, rather than to a parallel path — so a simulated
 * status and a real one are handled identically. Errors are contained: a simulated status fires
 * from a timer with nobody to reject to.
 *
 * The caller's provider objects are NOT written to. They are memoised per `env` and
 * `createMessaging` may run per request, so assigning the hook in place would have each instance
 * overwrite the previous one's closure — two messaging instances in one isolate would cross-wire
 * their simulated statuses into whichever ran last. Each provider instead gets a per-instance
 * view (`Object.create`, so a class-based provider keeps its prototype) carrying this instance's
 * hook as its own property, and the sends are made through that view.
 *
 * @returns The provider set this instance sends through.
 */
function wireSimulatedStatuses(
  providers: ProviderSet,
  options: WebhookDispatchOptions
): ProviderSet {
  const wire = <P extends { name: string }>(provider: P): P => {
    const providerName = provider.name;
    const view = Object.create(provider) as P & {
      onSimulatedStatus?: (event: StatusEvent) => void;
    };
    view.onSimulatedStatus = (event: StatusEvent): void => {
      void applyStatusEvents([event], providerName, options).catch(() => {
        // Nothing to report to: the status was fired by a timer, not a request.
      });
    };
    return view;
  };

  return {
    ...(providers.whatsapp && { whatsapp: wire(providers.whatsapp) }),
    ...(providers.sms && { sms: wire(providers.sms) }),
    ...(providers.email && { email: wire(providers.email) }),
  };
}

/**
 * The core for one `env` and one set of options: the status store, the providers wired for
 * simulated statuses, and the webhook dispatch options those statuses (and real vendor
 * callbacks) are applied through.
 *
 * Shared by `createMessaging` and {@link advanceChainFor} so a message sent on the request path
 * and one sent by a fallback advance go through the same wired providers — otherwise a console
 * provider's simulated `delivered` would be routed on one path and dropped on the other.
 */
function wiredCore<T extends Templates<Record<string, TemplateDef<unknown>>>>(
  env: MessagingEnv,
  options: MessagingOptions<T>,
  kv: KVNamespace
): { webhookOptions: WebhookDispatchOptions; providers: ProviderSet } {
  const store = statusStoreFor(env, options);
  const webhookOptions: WebhookDispatchOptions = {
    providers: memoProviders(env, options.providers),
    store,
    templates: options.templates,
    env,
    // The webhook module reports raw StatusEvents plus the ref it already resolved; forward them
    // in this module's onStatus shape so callers see one event type from sends and webhooks.
    // As on the send path, a throwing observer is logged (without content) and never fails the
    // batch or the webhook response.
    onStatus: options.onStatus
      ? (raw, ref) =>
          ref ? notifyStatus(options.onStatus, { ...ref, status: raw.status }) : undefined
      : undefined,
    onStatusApplied: ({ id, part, event, record }) =>
      part === 'chain' ? handleChainStatusApplied(id, event, record, env, options, kv) : undefined,
  };
  // The hook closes over `webhookOptions`, so the wired set can only be installed on it after it
  // exists; `applyStatusEvents` reads `providers` when a status actually fires.
  const providers = wireSimulatedStatuses(webhookOptions.providers ?? {}, webhookOptions);
  webhookOptions.providers = providers;
  return { webhookOptions, providers };
}

/**
 * Creates a messaging instance bound to a Worker env.
 *
 * Providers and the status store are memoised per `env` object, so calling this on every
 * request is cheap.
 *
 * @param env - Worker bindings; `MESSAGES_KV` is used unless `options.kv` is given.
 * @param options - Templates, provider factory, delivery defaults and callbacks.
 * @returns The messaging instance.
 * @throws {MessagingConfigError} If no KV namespace is available.
 * @throws {ProviderConfigError} If the provider set is missing fields or repeats a name.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMessaging<T extends Templates<any>>(
  env: MessagingEnv,
  options: MessagingOptions<T>
): Messaging<T> {
  const kv = requireKv(env, options);
  registerMessagingOptions(options);
  announceTimerOff(env, options.timer);
  const defaults: DeliveryPolicy = {
    fallback: options.delivery?.fallback ?? DEFAULT_POLICY.fallback,
    always: options.delivery?.always ?? DEFAULT_POLICY.always,
  };
  const templates = new Map<string, TemplateDef<unknown>>(Object.entries(options.templates));
  const { webhookOptions, providers } = wiredCore(env, options, kv);
  const store = webhookOptions.store as StatusStore;
  const webhook = createWebhookHandler(webhookOptions);

  return {
    send(args, ctx) {
      const templateName = String(args.template);
      const template = templates.get(templateName);
      if (!template) {
        return Promise.reject(new UnknownTemplateError(templateName));
      }
      return runSend(
        {
          providers,
          store,
          defaults,
          onStatus: options.onStatus,
          kv,
          timer: resolveTimer(env, options.timer),
          timeout: options.delivery?.timeout,
        },
        {
          templateName,
          template,
          to: args.to,
          email: args.email,
          locale: args.locale,
          input: args.input,
          delivery: args.delivery,
        },
        ctx
      );
    },
    status: (id) => store.get(id),
    handleWebhook: (provider, request, ctx) =>
      webhook(provider, request, ctx as Parameters<typeof webhook>[2]),
  };
}
