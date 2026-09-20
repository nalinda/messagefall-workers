/**
 * Fallback on failed delivery status or timeout.
 *
 * Advances delivery across configured fallback channels when a channel fails
 * or times out.
 *
 * The chain walk itself is NOT implemented here: this module resolves the remaining channels,
 * the render inputs and the provider set, then hands them to `runChain` / `attemptRecorder` in
 * `./send.js`, which is the single chain-advance implementation. Everything below is the
 * asynchronous entry point's own concerns — where the input comes from (`in:<id>` in KV, the
 * timer's state, or a synchronous pass-through) and what happens to the fallback timer and the
 * `in:<id>` key once the chain settles.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import type { MessagingEnv } from '../env.js';
import type { Channel, Provider } from '../providers/types.js';
import { type AnyRendered, type TemplateDef, validateInput } from '../templates.js';
import type { MessagingOptions } from './messaging.js';
import { asRenderInput, readRenderInput, releaseChain, type RenderInput } from './render-input.js';
import {
  attemptRecorder,
  notifyStatus,
  type ProviderSet,
  runChain,
  type SendDeps,
  type StatusCallbackEvent,
  type ValidatedSendRequest,
} from './send.js';
import type { Attempt, FallbackTimerClient, MessageRecord, StatusStore } from './status.js';

/**
 * Default fallback timeout used when the caller configures none.
 */
const DEFAULT_FALLBACK_TIMEOUT_MS = 10_000;

/**
 * Arguments for advancing the delivery fallback chain.
 */
export interface AdvanceChainArgs<Env = MessagingEnv> {
  /**
   * Internal message identifier.
   */
  id: string;
  /**
   * Reason for advancing the chain: delivery status failed or timer timed out.
   */
  reason: 'failed' | 'timeout';
  /**
   * Cloudflare Workers environment bindings (e.g. MESSAGES_KV, FALLBACK_TIMER).
   */
  env: Env;
  /**
   * Messaging options containing templates, providers, onStatus, etc.
   */
  options: Omit<Partial<MessagingOptions>, 'templates' | 'providers' | 'onStatus'> & {
    templates?: Record<string, TemplateDef<unknown>> | Map<string, TemplateDef<unknown>>;
    providers?:
      | Record<string, Provider>
      | Provider[]
      | Map<string, Provider>
      | ProviderSet
      | ((env: MessagingEnv) => ProviderSet);
    onStatus?: (event: StatusCallbackEvent) => void | Promise<void>;
    fallbackTimeoutMs?: number;
    kv?: KVNamespace;
    timer?: unknown;
  };
  /**
   * Status store for reading and updating delivery status records.
   */
  store: StatusStore;
  /**
   * Optional synchronous input pass-through from send pipeline (#3).
   */
  input?: unknown;
}

/**
 * Signature of the advanceChain function.
 */
export type AdvanceChainFn = (args: AdvanceChainArgs) => Promise<void>;

function asTimer(env: MessagingEnv, optionsTimer: unknown): FallbackTimerClient | undefined {
  const raw = optionsTimer ?? env.FALLBACK_TIMER;
  return raw && typeof raw === 'object' ? raw : undefined;
}

function rearmTimer(
  env: MessagingEnv,
  optionsTimer: unknown,
  id: string,
  timeoutMs: number,
  inputPayload?: RenderInput
): void {
  try {
    asTimer(env, optionsTimer)?.setState?.(id, timeoutMs, inputPayload);
  } catch {
    // Best-effort rearming
  }
}

function findInMap(
  providers: Map<string, Provider>,
  channel: Channel
): Provider<AnyRendered> | undefined {
  for (const p of providers.values()) {
    if (p.channel === channel) return p;
  }
  return undefined;
}

function findInObject(
  providers: Record<string, unknown>,
  channel: Channel
): Provider<AnyRendered> | undefined {
  for (const p of Object.values(providers)) {
    if (p && typeof p === 'object' && 'channel' in p && p.channel === channel) {
      return p as Provider<AnyRendered>;
    }
  }
  return undefined;
}

function findProviderForChannel(
  providers: AdvanceChainArgs['options']['providers'],
  env: MessagingEnv,
  channel: Channel
): Provider<AnyRendered> | undefined {
  if (!providers) return undefined;
  const resolved = typeof providers === 'function' ? providers(env) : providers;
  if (resolved instanceof Map) {
    return findInMap(resolved, channel);
  }
  if (Array.isArray(resolved)) {
    return resolved.find((p) => p.channel === channel);
  }
  if (typeof resolved === 'object') {
    return findInObject(resolved as Record<string, unknown>, channel);
  }
  return undefined;
}

/**
 * Normalises whatever shape the caller configured providers in into the per-channel
 * {@link ProviderSet} the send pipeline expects.
 */
function toProviderSet(
  providers: AdvanceChainArgs['options']['providers'],
  env: MessagingEnv
): ProviderSet {
  const find = (channel: Channel): Provider<AnyRendered> | undefined =>
    findProviderForChannel(providers, env, channel);
  const set: ProviderSet = {};
  const whatsapp = find('whatsapp');
  const sms = find('sms');
  const email = find('email');
  if (whatsapp) set.whatsapp = whatsapp;
  if (sms) set.sms = sms;
  if (email) set.email = email;
  return set;
}

function extractFromTimer(
  timer: FallbackTimerClient | undefined,
  id: string
): RenderInput | undefined {
  if (typeof timer?.getState !== 'function') {
    return undefined;
  }
  const state = timer.getState(id);
  if (!state?.input) {
    return undefined;
  }
  return asRenderInput(state.input);
}

async function resolveInputPayload(
  args: AdvanceChainArgs,
  kv: KVNamespace | undefined
): Promise<RenderInput> {
  if (args.input !== undefined && args.input !== null) {
    return asRenderInput(args.input);
  }

  const fromTimer = extractFromTimer(asTimer(args.env, args.options.timer), args.id);
  if (fromTimer) {
    return fromTimer;
  }

  const fromKV = await readRenderInput(kv, args.id);
  if (fromKV) {
    return fromKV;
  }

  return { input: {} };
}

function resolveTemplate(
  templates: AdvanceChainArgs['options']['templates'],
  templateName: string
): TemplateDef<unknown> | undefined {
  if (templates instanceof Map) {
    return templates.get(templateName);
  }
  if (templates && typeof templates === 'object') {
    return Reflect.get(templates, templateName);
  }
  return undefined;
}

function shouldSkipAdvancement(
  record: MessageRecord | null,
  reason: 'failed' | 'timeout'
): boolean {
  if (!record || record.chain.status === 'delivered' || record.chain.status === 'read') {
    return true;
  }
  const lastAttempt = record.chain.attempts.at(-1);
  if (!lastAttempt || lastAttempt.status === 'delivered' || lastAttempt.status === 'read') {
    return true;
  }
  return reason === 'failed' && lastAttempt.status !== 'failed';
}

/**
 * Builds the {@link SendDeps} the shared pipeline needs for this advance. `defaults` is the
 * record's own resolved policy: the chain status derivation must see the policy the message was
 * created with, not whatever the instance defaults are now.
 */
function sendDeps(args: AdvanceChainArgs, providers: ProviderSet, record: MessageRecord): SendDeps {
  return {
    providers,
    store: args.store,
    defaults: record.policy,
    ...(args.options.onStatus && { onStatus: args.options.onStatus }),
  };
}

/**
 * Seals a chain that has no channel left to try: re-derives the terminal `failed` status through
 * the same recorder the walk uses, notifies the observer for the attempt that ended it, then
 * releases the timer and the stored input.
 */
async function finalizeExhaustion(
  args: AdvanceChainArgs,
  record: MessageRecord,
  lastAttempt: Attempt,
  kv: KVNamespace | undefined
): Promise<void> {
  const recorder = attemptRecorder(sendDeps(args, {}, record), args.id, record.policy);
  await recorder.sealChain({
    attempted: Math.max(record.policy.fallback.length, record.chain.attempts.length),
    last: 'failed',
  });

  if (args.options.onStatus) {
    await notifyStatus(args.options.onStatus, {
      id: args.id,
      channel: lastAttempt.channel,
      provider: lastAttempt.provider,
      status: 'failed',
    });
  }

  await release(args, kv);
}

/**
 * This module's call into the shared terminal-state cleanup, with the timer resolved the same
 * way every other path here resolves it.
 */
async function release(args: AdvanceChainArgs, kv: KVNamespace | undefined): Promise<void> {
  await releaseChain(asTimer(args.env, args.options.timer), kv, args.id);
}

/**
 * A template with no channel rendering, used when the record names a template the caller's
 * catalogue no longer has: every channel then fails to render and is recorded as a failed
 * attempt rather than dispatched with an empty body.
 */
function missingTemplate(kind: MessageRecord['kind']): TemplateDef<unknown> {
  return { kind };
}

/**
 * Rebuilds the `ValidatedSendRequest` that `runChain` renders from, out of the record and the
 * input payload recovered from KV / the timer / the caller.
 */
function rebuildRequest(
  record: MessageRecord,
  template: TemplateDef<unknown> | undefined,
  payload: RenderInput
): ValidatedSendRequest {
  const locale = payload.locale ?? 'en';
  return {
    templateName: record.template,
    template: template ?? missingTemplate(record.kind),
    to: payload.to ?? '',
    email: payload.email ?? payload.to,
    locale,
    input: payload.input,
    validatedInput: template ? validateInput(template, payload.input) : payload.input,
  };
}

/**
 * Advances delivery fallback chain when an attempt fails or times out.
 *
 * Resolves the channels still untried, rebuilds the render inputs, then delegates the walk to
 * `runChain` with a recorder from `attemptRecorder` — the same pair the synchronous send path
 * uses, so both paths derive chain and overall status identically. Once the walk settles the
 * timer is re-armed (a channel accepted the message) or the chain is released (exhausted).
 *
 * @param args - Arguments including message id, reason, env, options, and status store.
 */
export async function advanceChain(args: AdvanceChainArgs): Promise<void> {
  const record = await args.store.get(args.id);
  if (shouldSkipAdvancement(record, args.reason)) {
    return;
  }

  const initialRecord = record as MessageRecord;
  const lastAttempt = initialRecord.chain.attempts.at(-1) as Attempt;
  const fallback = initialRecord.policy.fallback;
  const lastIndex = fallback.indexOf(lastAttempt.channel);
  const nextChannels = lastIndex === -1 ? [] : fallback.slice(lastIndex + 1);
  const kv = args.options.kv ?? args.env.MESSAGES_KV;

  if (nextChannels.length === 0) {
    await finalizeExhaustion(args, initialRecord, lastAttempt, kv);
    return;
  }

  const payload = await resolveInputPayload(args, kv);
  const template = resolveTemplate(args.options.templates, initialRecord.template);
  const providers = toProviderSet(args.options.providers, args.env);
  const recorder = attemptRecorder(
    sendDeps(args, providers, initialRecord),
    args.id,
    initialRecord.policy
  );

  const attempts = await runChain(
    rebuildRequest(initialRecord, template, payload),
    args.id,
    providers,
    nextChannels,
    recorder
  );

  const last = attempts.at(-1);
  if (!last || last.status === 'failed') {
    await release(args, kv);
    return;
  }

  rearmTimer(
    args.env,
    args.options.timer,
    args.id,
    args.options.fallbackTimeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS,
    payload
  );
}
