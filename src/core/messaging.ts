/**
 * createMessaging: builds providers and the status store per env and exposes send/status.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import type { InputOf, TemplateDef, Templates } from '../templates.js';
import type { MessagingEnv } from '../types.js';
import { DEFAULT_POLICY, type DeliveryOverride, type DeliveryPolicy } from './policy.js';
import { type ProviderSet, runSend, type SendContext, type StatusCallbackEvent } from './send.js';
import {
  DEFAULT_STATUS_TTL,
  kvStatusStore,
  type MessageRecord,
  type StatusStore,
} from './status.js';

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
  timer?: unknown;
  statusTtl?: number;
  onStatus?: (event: StatusCallbackEvent) => void | Promise<void>;
}

/**
 * Arguments to Messaging#send.
 */
export interface SendArgs<T, K extends keyof T> {
  template: K;
  to: string;
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
}

/**
 * Thrown when no KV namespace is available for the status store.
 */
export class MessagingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessagingConfigError';
  }
}

const providerCache = new WeakMap<MessagingEnv, WeakMap<object, ProviderSet>>();
const storeCache = new WeakMap<KVNamespace, Map<number, StatusStore>>();

function memoProviders(env: MessagingEnv, build: (env: MessagingEnv) => ProviderSet): ProviderSet {
  let byBuilder = providerCache.get(env);
  if (!byBuilder) {
    byBuilder = new WeakMap();
    providerCache.set(env, byBuilder);
  }
  let set = byBuilder.get(build);
  if (!set) {
    set = build(env);
    byBuilder.set(build, set);
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
 * Creates a messaging instance bound to a Worker env.
 *
 * Providers and the status store are memoised per `env` object, so calling this on every
 * request is cheap.
 *
 * @param env - Worker bindings; `MESSAGES_KV` is used unless `options.kv` is given.
 * @param options - Templates, provider factory, delivery defaults and callbacks.
 * @returns The messaging instance.
 * @throws {MessagingConfigError} If no KV namespace is available.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMessaging<T extends Templates<any>>(
  env: MessagingEnv,
  options: MessagingOptions<T>
): Messaging<T> {
  const kv = options.kv ?? env.MESSAGES_KV;
  if (!kv) {
    throw new MessagingConfigError('createMessaging needs options.kv or env.MESSAGES_KV');
  }
  const defaults: DeliveryPolicy = {
    fallback: options.delivery?.fallback ?? DEFAULT_POLICY.fallback,
    always: options.delivery?.always ?? DEFAULT_POLICY.always,
  };
  const store = memoStore(kv, options.statusTtl ?? DEFAULT_STATUS_TTL);
  const templates = new Map<string, TemplateDef<unknown>>(Object.entries(options.templates));

  return {
    send(args, ctx) {
      const templateName = String(args.template);
      const template = templates.get(templateName);
      if (!template) {
        return Promise.reject(new MessagingConfigError(`Unknown template "${templateName}"`));
      }
      return runSend(
        {
          providers: memoProviders(env, options.providers),
          store,
          defaults,
          onStatus: options.onStatus,
        },
        {
          templateName,
          template,
          to: args.to,
          locale: args.locale,
          input: args.input,
          delivery: args.delivery,
        },
        ctx
      );
    },
    status: (id) => store.get(id),
  };
}
