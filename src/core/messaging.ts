/**
 * createMessaging: builds providers and the status store per env and exposes send/status.
 *
 * @module
 */

import type { DurableObjectNamespace, KVNamespace } from '@cloudflare/workers-types';

import type { Provider } from '../providers/types.js';
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
 * Thrown for a configuration fault (no KV namespace for the status store, or a second
 * `providers` factory for an `env` whose providers are already memoised) and for a send that
 * names a template the catalogue does not define.
 */
export class MessagingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessagingConfigError';
  }
}

type ProviderFactory = (env: MessagingEnv) => ProviderSet;

const providerCache = new WeakMap<MessagingEnv, { build: ProviderFactory; set: ProviderSet }>();

/**
 * Thrown by createMessaging when the provider set built from env is invalid.
 */
export class ProviderConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    const bullets = problems.map((problem) => `- ${problem}`).join('\n');
    super(`Provider configuration validation failed:\n${bullets}`);
    this.name = 'ProviderConfigError';
    this.problems = problems;
  }
}

function missingProviderFields(p: Partial<Provider>): string[] {
  const missing: string[] = [];
  if (!p.name) missing.push('name');
  if (!p.channel) missing.push('channel');
  if (typeof p.send !== 'function') missing.push('send');
  return missing;
}

function validateProviderSet(set: ProviderSet): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [slot, candidate] of Object.entries(set)) {
    const p = candidate as Partial<Provider> | undefined;
    if (!p) {
      continue;
    }
    const missing = missingProviderFields(p);
    if (missing.length > 0) {
      problems.push(`Provider "${slot}" is missing required field(s): ${missing.join(', ')}`);
    }
    if (p.name && seen.has(p.name)) {
      problems.push(`Duplicate provider name "${p.name}" configured across multiple providers`);
    }
    if (p.name) {
      seen.add(p.name);
    }
  }
  if (problems.length > 0) {
    throw new ProviderConfigError(problems);
  }
}
const storeCache = new WeakMap<KVNamespace, Map<number, StatusStore>>();

function memoProviders(env: MessagingEnv, build: ProviderFactory): ProviderSet {
  const cached = providerCache.get(env);
  if (cached) {
    if (cached.build !== build) {
      throw new MessagingConfigError(
        'createMessaging was called with a different `providers` factory for an env whose providers are already memoised; use one factory per env'
      );
    }
    return cached.set;
  }
  const set = build(env);
  validateProviderSet(set);
  providerCache.set(env, { build, set });
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
 * @throws {MessagingConfigError} If no KV namespace is available, or `env` already has
 * providers memoised from a different `providers` factory.
 * @throws {ProviderConfigError} If the provider set is missing fields or repeats a name.
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
  const providers = memoProviders(env, options.providers);
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
          providers,
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
