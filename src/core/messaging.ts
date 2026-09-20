/**
 * createMessaging: builds providers and the status store per env and exposes send/status.
 *
 * @module
 */

import type { DurableObjectNamespace, KVNamespace } from '@cloudflare/workers-types';

import type { MessagingEnv } from '../env.js';
import type { Provider, StatusEvent } from '../providers/types.js';
import type { InputOf, TemplateDef, Templates } from '../templates.js';
import { advanceChain } from './fallback.js';
import { DEFAULT_POLICY, type DeliveryOverride, type DeliveryPolicy } from './policy.js';
import { validateProviderSet } from './provider-set.js';
import {
  notifyStatus,
  type ProviderSet,
  runSend,
  type SendContext,
  type StatusCallbackEvent,
} from './send.js';
import {
  DEFAULT_STATUS_TTL,
  kvStatusStore,
  type MessageRecord,
  type StatusStore,
} from './status.js';
import { createWebhookHandler } from './webhook.js';

export { ProviderConfigError } from './provider-set.js';
export type { ProviderSet, SendContext, StatusCallbackEvent } from './send.js';
export { E164, RecipientError } from './send.js';

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

async function handleChainStatusApplied<T extends Templates<Record<string, TemplateDef<unknown>>>>(
  id: string,
  event: StatusEvent,
  env: MessagingEnv,
  options: MessagingOptions<T>,
  providers: ProviderSet,
  store: StatusStore,
  kv: KVNamespace
): Promise<void> {
  if (event.status === 'failed') {
    await advanceChain({
      id,
      reason: 'failed',
      env,
      options: {
        templates: options.templates,
        providers,
        onStatus: options.onStatus,
        fallbackTimeoutMs: options.delivery?.timeout?.notification,
        kv,
        timer: options.timer,
      },
      store,
    });
    return;
  }

  if (event.status === 'delivered' || event.status === 'read') {
    const timer = (options.timer ?? env.FALLBACK_TIMER) as
      { cancel?: (timerId: string) => void } | undefined;
    try {
      timer?.cancel?.(id);
    } catch {
      // ignore
    }
    try {
      await kv.delete(`in:${id}`);
    } catch {
      // ignore
    }
  }
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
  const kv = options.kv ?? (env as Partial<MessagingEnv>).MESSAGES_KV;
  if (!kv) {
    throw new MessagingConfigError('createMessaging needs options.kv or env.MESSAGES_KV');
  }
  const defaults: DeliveryPolicy = {
    fallback: options.delivery?.fallback ?? DEFAULT_POLICY.fallback,
    always: options.delivery?.always ?? DEFAULT_POLICY.always,
  };
  const store = memoStore(kv, options.statusTtl ?? DEFAULT_STATUS_TTL);
  const providers = memoProviders(env, options.providers);
  const templates = new Map<string, TemplateDef<unknown>>(Object.entries(options.templates));
  const webhook = createWebhookHandler({
    providers: providers as Record<string, Provider>,
    store,
    templates: options.templates,
    env,
    // The webhook module reports raw StatusEvents plus the ref it already resolved; forward them
    // in this module's onStatus shape so callers see one event type from sends and webhooks.
    // As on the send path, a throwing observer is logged (without content) and never fails the
    // batch or the webhook response.
    onStatus: options.onStatus
      ? (raw, ref) =>
          ref
            ? notifyStatus(options.onStatus, { ...ref, status: (raw as StatusEvent).status })
            : undefined
      : undefined,
    onStatusApplied: ({ id, part, event }) =>
      part === 'chain'
        ? handleChainStatusApplied(id, event, env, options, providers, store, kv)
        : undefined,
  });

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
