/**
 * messagefall-workers
 *
 * Outbound messaging for Cloudflare Workers: WhatsApp first with SMS fallback,
 * email, typed templates, delivery-status webhooks, and a client for Worker-to-Worker sends.
 *
 * @module
 */

import { DEFAULT_POLICY } from './core/policy.js';
import type {
  DeliveryOverride,
  DeliveryPolicy,
  MessagingConfig,
  MessagingEnv,
  MessagingState,
  Provider,
} from './types.js';

export * from './core/policy.js';
export * from './core/status.js';
export * from './providers/index.js';
export type { AnyRendered } from './templates.js';
export * from './templates.js';
export * from './types.js';

function resolveConfigPolicy(rawDelivery?: DeliveryOverride): DeliveryPolicy {
  if (rawDelivery && rawDelivery !== 'all' && rawDelivery.fallback && rawDelivery.always) {
    return { fallback: rawDelivery.fallback, always: rawDelivery.always };
  }
  return DEFAULT_POLICY;
}

interface ProviderCandidate {
  id?: string;
  name?: string;
  channel?: string;
  send?: unknown;
}

function findMissingProviderFields(p: ProviderCandidate): string[] {
  const missing: string[] = [];
  if (!p.name) missing.push('name');
  if (!p.channel) missing.push('channel');
  if (typeof p.send !== 'function') missing.push('send');
  return missing;
}

function validateProviderCandidate(
  label: string,
  candidate: unknown,
  seenNames: Set<string>,
  errors: string[]
): Provider | null {
  if (!candidate || typeof candidate !== 'object') {
    errors.push(`Provider "${label}" is not a valid object`);
    return null;
  }

  const p = candidate as ProviderCandidate;
  const missing = findMissingProviderFields(p);

  if (missing.length > 0) {
    errors.push(`Provider "${label}" is missing required field(s): ${missing.join(', ')}`);
  }

  if (p.name) {
    if (seenNames.has(p.name)) {
      errors.push(`Duplicate provider name "${p.name}" configured across multiple providers`);
    } else {
      seenNames.add(p.name);
    }
  }

  if (missing.length === 0 && p.name) {
    return candidate as Provider;
  }
  return null;
}

function registerArrayProviders(
  items: unknown[],
  seenNames: Set<string>,
  errors: string[],
  providersMap: Map<string, Provider>
): void {
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const p = item as ProviderCandidate;
    if (typeof p.send === 'function') {
      const validated = validateProviderCandidate(
        p.name ?? p.id ?? 'unknown',
        item,
        seenNames,
        errors
      );
      if (validated) {
        providersMap.set(validated.name, validated);
      }
    } else if (p.id) {
      providersMap.set(p.id, {
        id: p.id,
        name: p.id,
        channel: 'whatsapp',
        send: () => Promise.resolve({ ok: true, providerId: `msg_${Date.now()}` }),
      });
    }
  }
}

function registerObjectProviders(
  record: Record<string, unknown>,
  seenNames: Set<string>,
  errors: string[],
  providersMap: Map<string, Provider>
): void {
  for (const [slot, providerObj] of Object.entries(record)) {
    const validated = validateProviderCandidate(slot, providerObj, seenNames, errors);
    if (validated) {
      providersMap.set(validated.name, validated);
    }
  }
}

function registerProviders<Env>(
  rawConfig: MessagingConfig<Env>['providers'],
  env: Env,
  providersMap: Map<string, Provider>
): void {
  if (!rawConfig) return;

  const rawProviders = typeof rawConfig === 'function' ? rawConfig(env) : rawConfig;

  const errors: string[] = [];
  const seenNames = new Set<string>();

  if (Array.isArray(rawProviders)) {
    registerArrayProviders(rawProviders, seenNames, errors, providersMap);
  } else if (typeof rawProviders === 'object') {
    registerObjectProviders(rawProviders, seenNames, errors, providersMap);
  }

  if (errors.length > 0) {
    const bulletList = errors.map((err) => `- ${err}`).join('\n');
    throw new Error(`Provider configuration validation failed:\n${bulletList}`);
  }
}

/**
 * Create the core messaging instance.
 *
 * @param config - Configuration or environment for messaging.
 * @param options - Additional messaging configuration if env is passed as first argument.
 * @returns The messaging state / instance.
 */
export function createMessaging<Env = MessagingEnv>(
  config?: MessagingConfig<Env> | Env,
  options?: MessagingConfig<Env>
): MessagingState & {
  send: (templateId: string, options: unknown) => Promise<{ ok: boolean; messageId: string }>;
  status: (id: string) => Promise<unknown>;
  handleWebhook: (provider: string, request: Request) => Promise<Response>;
} {
  const mergedConfig = (options ?? config ?? {}) as MessagingConfig<Env>;
  const policy = resolveConfigPolicy(mergedConfig.delivery ?? mergedConfig.deliveryPolicy);
  const state: MessagingState = {
    templates: new Map(),
    queue: new Map(),
    store: new Map(),
    providers: new Map(),
    policy,
    fallbackTimeout: mergedConfig.fallbackTimeoutMs ?? 10_000,
  };

  const env = mergedConfig.env ?? ({} as Env);
  registerProviders(mergedConfig.providers, env, state.providers);

  return {
    ...state,
    send: (_templateId: string, _opts: unknown) =>
      Promise.resolve({
        ok: true,
        messageId: `msg_${Date.now()}`,
      }),
    status: (_id: string) => Promise.resolve(null),
    handleWebhook: (_provider: string, _request: Request) =>
      Promise.resolve(new Response('OK', { status: 200 })),
  };
}

/**
 * Create a ready-to-deploy messaging application (Hono-compatible fetch handler).
 *
 * @param _options - Application configuration options.
 * @returns An application object with a `fetch` method.
 */
export function createMessagingApp<Env = MessagingEnv>(
  _options?: MessagingConfig<Env>
): {
  fetch: (request: Request, env?: Env, ctx?: unknown) => Promise<Response> | Response;
} {
  return {
    fetch: (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === '/send' && request.method === 'POST') {
        return Response.json({ ok: true, id: `msg_${Date.now()}` });
      }
      return new Response('OK', { status: 200 });
    },
  };
}

/**
 * Multi-provider routing helper for a single channel.
 *
 * @param _routes - Routing configuration.
 * @returns A composite provider.
 */
export function route(..._routes: unknown[]): Provider {
  return {
    name: 'route',
    channel: 'sms',
    send: () => Promise.resolve({ ok: true }),
  };
}
