/**
 * Environment validation and typed MessagingEnv bindings for Cloudflare Workers.
 *
 * @module
 */

import type { DurableObjectNamespace, KVNamespace } from '@cloudflare/workers-types';

import type { MessagingOptions } from './core/messaging.js';
import type { Channel, Provider } from './providers/types.js';
import { definedChannels, type TemplateDef } from './templates.js';

const VALID_CHANNELS: readonly Channel[] = ['whatsapp', 'sms', 'email'] as const;

/**
 * Base environment bindings for messaging (Issue #13 interface).
 */
export interface MessagingEnv {
  MESSAGES_KV: KVNamespace;
  FALLBACK_TIMER?: DurableObjectNamespace;
  MESSAGING_DEV_UNSIGNED?: string;
  [key: string]: unknown;
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null;
}

function checkKvNamespace(val: unknown): string | null {
  if (
    !isRecord(val) ||
    typeof val.get !== 'function' ||
    typeof val.put !== 'function' ||
    typeof val.delete !== 'function'
  ) {
    return 'MESSAGES_KV must be a valid KVNamespace';
  }
  return null;
}

function hasNamespaceMethod(val: Record<string, unknown>): boolean {
  if (typeof val.idFromName === 'function') return true;
  if (typeof val.idFromString === 'function') return true;
  if (typeof val.newUniqueId === 'function') return true;
  return typeof val.get === 'function';
}

function isDurableObjectNamespace(val: Record<string, unknown>): boolean {
  return hasNamespaceMethod(val);
}

function checkFallbackTimer(val: unknown): string | null {
  if (val === undefined) {
    return null;
  }
  return isRecord(val) && isDurableObjectNamespace(val)
    ? null
    : 'FALLBACK_TIMER must be a valid DurableObjectNamespace';
}

function checkChannelList(channels: unknown, name: 'fallback' | 'always'): string[] {
  if (!Array.isArray(channels)) {
    return [`Malformed default delivery policy: ${name} must be an array`];
  }
  const problems: string[] = [];
  for (const ch of channels) {
    if (!VALID_CHANNELS.includes(ch as Channel)) {
      problems.push(`Malformed default delivery policy: invalid ${name} channel "${String(ch)}"`);
    }
  }
  return problems;
}

function checkTimeout(timeout: unknown): string[] {
  if (!isRecord(timeout)) {
    return ['Malformed default delivery policy: timeout must be an object'];
  }
  const problems: string[] = [];
  const { otp, notification } = timeout as { otp?: unknown; notification?: unknown };
  if (otp !== undefined && (typeof otp !== 'number' || Number.isNaN(otp))) {
    problems.push('Malformed default delivery policy: timeout.otp must be a number');
  }
  if (
    notification !== undefined &&
    (typeof notification !== 'number' || Number.isNaN(notification))
  ) {
    problems.push('Malformed default delivery policy: timeout.notification must be a number');
  }
  return problems;
}

function validateDeliveryPolicy(delivery: unknown): string[] {
  if (delivery === undefined) {
    return [];
  }
  if (!isRecord(delivery)) {
    return ['Malformed default delivery policy: must be an object'];
  }
  const problems: string[] = [];
  const d = delivery as { fallback?: unknown; always?: unknown; timeout?: unknown };
  if (d.fallback !== undefined) {
    problems.push(...checkChannelList(d.fallback, 'fallback'));
  }
  if (d.always !== undefined) {
    problems.push(...checkChannelList(d.always, 'always'));
  }
  if (d.timeout !== undefined) {
    problems.push(...checkTimeout(d.timeout));
  }
  return problems;
}

function checkTemplateDelivery(
  templateName: string,
  def: TemplateDef<unknown>,
  channels: readonly Channel[]
): void {
  if (!def.delivery || def.delivery === 'all') {
    return;
  }
  const listToCheck = [...(def.delivery.fallback ?? []), ...(def.delivery.always ?? [])];
  for (const ch of listToCheck) {
    if (!channels.includes(ch)) {
      throw new Error(`Template "${templateName}" delivery references undefined channel "${ch}"`);
    }
  }
}

function validateTemplateDefinition(templateName: string, def: TemplateDef<unknown>): void {
  const channels = definedChannels(def);
  if (channels.length === 0) {
    throw new Error(`Template "${templateName}" must define at least one channel rendering`);
  }
  if (
    def.kind === 'otp' &&
    def.whatsapp &&
    'text' in def.whatsapp &&
    typeof def.whatsapp.text === 'function'
  ) {
    throw new Error(
      `Template "${templateName}" of kind "otp" must not use whatsapp.text (Meta requires an authentication template for codes)`
    );
  }
  checkTemplateDelivery(templateName, def, channels);
}

function validateProviderSlot(slot: string, p: Partial<Provider>): string[] {
  const problems: string[] = [];
  const knownSlots = new Set<string>(VALID_CHANNELS);
  if (!knownSlots.has(slot)) {
    problems.push(
      `Provider slot "${slot}" is not a channel (expected one of ${VALID_CHANNELS.join(', ')})`
    );
  }
  const missing: string[] = [];
  if (!p.name || typeof p.name !== 'string') missing.push('name');
  if (!p.channel || typeof p.channel !== 'string') missing.push('channel');
  if (typeof p.send !== 'function') missing.push('send');
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

function validateProviderSlots(set: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const seenNames = new Set<string>();

  for (const [slot, candidate] of Object.entries(set)) {
    if (!candidate) continue;
    const p = candidate as Partial<Provider>;
    problems.push(...validateProviderSlot(slot, p));
    if (p.name && typeof p.name === 'string') {
      if (seenNames.has(p.name)) {
        problems.push(`Duplicate provider name "${p.name}" configured across multiple providers`);
      } else {
        seenNames.add(p.name);
      }
    }
  }
  return problems;
}

function validateProviders(env: unknown, providersFn: unknown): string[] {
  if (typeof providersFn !== 'function') {
    return ['providers option must be a function'];
  }

  let set: unknown;
  try {
    const dummyEnv = isRecord(env) ? (env as MessagingEnv) : ({} as MessagingEnv);
    set = (providersFn as (e: MessagingEnv) => unknown)(dummyEnv);
  } catch (err: unknown) {
    return [
      `providers function threw an error during evaluation: ${err instanceof Error ? err.message : String(err)}`,
    ];
  }

  if (!isRecord(set)) {
    return ['providers function must return an object'];
  }

  return validateProviderSlots(set);
}

function validateTemplates(templates: unknown): string[] {
  if (!isRecord(templates)) {
    return ['Missing required templates option'];
  }
  const problems: string[] = [];
  for (const [templateName, def] of Object.entries(templates)) {
    try {
      validateTemplateDefinition(templateName, def as TemplateDef<unknown>);
    } catch (err: unknown) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  return problems;
}

/**
 * Startup validation for environment bindings and messaging options.
 * Collects all configuration and environment problems and throws them as a single error.
 *
 * @param env - Worker bindings environment.
 * @param options - Application configuration options.
 * @throws {Error} If any validation problems are found.
 */
export function validateEnv(
  env: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: MessagingOptions<any>
): asserts env is MessagingEnv {
  const problems: string[] = [];

  if (!isRecord(env) || !('MESSAGES_KV' in env) || env.MESSAGES_KV === undefined) {
    problems.push('Missing required binding MESSAGES_KV');
  } else {
    const kvError = checkKvNamespace(env.MESSAGES_KV);
    if (kvError) {
      problems.push(kvError);
    }
  }

  if (isRecord(env) && 'FALLBACK_TIMER' in env) {
    const timerError = checkFallbackTimer(env.FALLBACK_TIMER);
    if (timerError) {
      problems.push(timerError);
    }
  }

  problems.push(
    ...validateDeliveryPolicy(options.delivery),
    ...validateTemplates(options.templates),
    ...validateProviders(env, options.providers)
  );

  if (problems.length > 0) {
    const bullets = problems.map((problem) => `- ${problem}`).join('\n');
    throw new Error(`Environment and configuration validation failed:\n${bullets}`);
  }
}
