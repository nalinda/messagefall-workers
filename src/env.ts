/**
 * Environment validation and typed MessagingEnv bindings for Cloudflare Workers.
 *
 * @module
 */

import type { DurableObjectNamespace, KVNamespace } from '@cloudflare/workers-types';

import type { MessagingOptions } from './core/messaging.js';
import { providerSetProblems } from './core/provider-set.js';
import { isDurableObjectNamespace } from './core/timer.js';
import { isRecord } from './core/values.js';
import { type Channel, CHANNELS } from './providers/types.js';
import { type TemplateDef, validateTemplateDef } from './templates.js';

/**
 * Base environment bindings for messaging (Issue #13 interface).
 */
export interface MessagingEnv {
  MESSAGES_KV: KVNamespace;
  FALLBACK_TIMER?: DurableObjectNamespace;
  MESSAGING_DEV_UNSIGNED?: string;
  [key: string]: unknown;
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

/**
 * Deliberately the very same predicate `resolveTimer` uses, imported rather than restated: a
 * looser check here would pass a binding at startup that `resolveTimer` then refuses to adapt —
 * a `KVNamespace` bound as `FALLBACK_TIMER`, say, which would come back out as a
 * `FallbackTimerClient` with no `arm` or `cancel` and turn timed fallback off in silence. One
 * predicate means a binding either passes validation and works, or fails loudly at startup.
 */
function checkFallbackTimer(val: unknown): string | null {
  if (val === undefined) {
    return null;
  }
  return isDurableObjectNamespace(val)
    ? null
    : 'FALLBACK_TIMER must be a valid DurableObjectNamespace';
}

function checkChannelList(channels: unknown, name: 'fallback' | 'always'): string[] {
  if (!Array.isArray(channels)) {
    return [`Malformed default delivery policy: ${name} must be an array`];
  }
  const problems: string[] = [];
  for (const ch of channels) {
    if (!CHANNELS.includes(ch as Channel)) {
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

  return providerSetProblems(set);
}

function validateTemplates(templates: unknown): string[] {
  if (!isRecord(templates)) {
    return ['Missing required templates option'];
  }
  const problems: string[] = [];
  for (const [templateName, def] of Object.entries(templates)) {
    try {
      validateTemplateDef(templateName, def as TemplateDef<unknown>);
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
