/**
 * createMessaging: builds providers and the status store per env and exposes send/status.
 *
 * @module
 */

import type { DurableObjectNamespace, KVNamespace } from '@cloudflare/workers-types';

import type { Provider } from '../providers/types.js';
import type { InputOf, TemplateDef, Templates } from '../templates.js';
import { CHANNELS, type MessagingEnv } from '../types.js';
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
  /**
   * Handles a provider's delivery-status webhook. Implemented in #5; until then responds 501.
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

const KNOWN_SLOTS: ReadonlySet<string> = new Set(CHANNELS);

/**
 * Problems with one provider in isolation: unknown slot, missing fields, channel/slot mismatch.
 */
function slotProblems(slot: string, p: Partial<Provider>): string[] {
  const problems: string[] = [];
  if (!KNOWN_SLOTS.has(slot)) {
    // Same union `providerFor` switches on; anything else could never be sent through.
    problems.push(
      `Provider slot "${slot}" is not a channel (expected one of ${CHANNELS.join(', ')})`
    );
  }
  const missing = missingProviderFields(p);
  if (missing.length > 0) {
    problems.push(`Provider "${slot}" is missing required field(s): ${missing.join(', ')}`);
  }
  if (p.channel && p.channel !== slot) {
    problems.push(
      `Provider "${slot}" declares channel "${p.channel}" but is registered under the "${slot}" slot`
    );
  }
  return problems;
}

function validateProviderSet(set: ProviderSet): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [slot, candidate] of Object.entries(set)) {
    const p = candidate as Partial<Provider> | undefined;
    if (!p) {
      continue;
    }
    problems.push(...slotProblems(slot, p));
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
          locale: args.locale,
          input: args.input,
          delivery: args.delivery,
        },
        ctx
      );
    },
    status: (id) => store.get(id),
    handleWebhook: () => Promise.resolve(new Response('Not Implemented', { status: 501 })),
  };
}
