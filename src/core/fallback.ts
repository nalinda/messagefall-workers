/**
 * Fallback on failed delivery status or timeout.
 *
 * Advances delivery across configured fallback channels when a channel fails
 * or times out.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import { renderValidated, validateInput } from '../templates.js';
import type {
  AnyRendered,
  Channel,
  MessagingEnv,
  OutboundMeta,
  Provider,
  SendResult,
  TemplateDef,
} from '../types.js';
import { scrubError } from './logger.js';
import type { MessagingOptions } from './messaging.js';
import { NO_PROVIDER, notifyStatus, type ProviderSet, type StatusCallbackEvent } from './send.js';
import {
  type Attempt,
  deriveOverallStatus,
  type MessageRecord,
  type StatusStore,
} from './status.js';

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

interface MockTimerCandidate {
  getState?: (id: string) => { input?: unknown } | null;
  setState?: (id: string, timeoutMs: number, input?: unknown) => void;
  cancel?: (id: string) => void;
}

interface InputPayload {
  input: unknown;
  to?: string;
  locale?: string;
}

function cancelTimer(env: MessagingEnv, optionsTimer: unknown, id: string): void {
  const timer = (optionsTimer ?? env.FALLBACK_TIMER) as MockTimerCandidate | undefined;
  try {
    timer?.cancel?.(id);
  } catch {
    // Best-effort cancellation
  }
}

function rearmTimer(
  env: MessagingEnv,
  optionsTimer: unknown,
  id: string,
  timeoutMs: number,
  inputPayload?: unknown
): void {
  const timer = (optionsTimer ?? env.FALLBACK_TIMER) as MockTimerCandidate | undefined;
  try {
    timer?.setState?.(id, timeoutMs, inputPayload);
  } catch {
    // Best-effort rearming
  }
}

async function deleteKVInput(kv: KVNamespace | undefined, id: string): Promise<void> {
  try {
    await kv?.delete(`in:${id}`);
  } catch {
    // Best-effort deletion
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
  providers:
    | Record<string, Provider>
    | Provider[]
    | Map<string, Provider>
    | ProviderSet
    | ((env: MessagingEnv) => ProviderSet)
    | undefined,
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

function extractFromTimer(timerCandidate: unknown, id: string): InputPayload | undefined {
  const timer = timerCandidate as MockTimerCandidate | undefined;
  if (typeof timer?.getState !== 'function') {
    return undefined;
  }
  const state = timer.getState(id);
  if (!state?.input) {
    return undefined;
  }
  if (typeof state.input === 'object' && 'input' in state.input) {
    return state.input;
  }
  return { input: state.input };
}

async function extractFromKV(
  kv: KVNamespace | undefined,
  id: string
): Promise<InputPayload | undefined> {
  if (!kv || typeof kv.get !== 'function') {
    return undefined;
  }
  const raw = await kv.get(`in:${id}`);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && 'input' in parsed) {
      return parsed;
    }
    return { input: parsed };
  } catch {
    return undefined;
  }
}

async function resolveInputPayload(
  args: AdvanceChainArgs,
  kv: KVNamespace | undefined
): Promise<InputPayload> {
  if (args.input !== undefined && args.input !== null) {
    if (typeof args.input === 'object' && 'input' in args.input) {
      return args.input;
    }
    return { input: args.input };
  }

  const fromTimer = extractFromTimer(args.options.timer ?? args.env.FALLBACK_TIMER, args.id);
  if (fromTimer) {
    return fromTimer;
  }

  const fromKV = await extractFromKV(kv, args.id);
  if (fromKV) {
    return fromKV;
  }

  return { input: {} };
}

function resolveTemplate(
  templates: Record<string, TemplateDef<unknown>> | Map<string, TemplateDef<unknown>> | undefined,
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

async function attemptSend(
  provider: Provider<AnyRendered>,
  sendPayload: AnyRendered & OutboundMeta
): Promise<SendResult> {
  let result: SendResult;
  try {
    result = await provider.send(sendPayload);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!result.ok && result.retryable) {
    try {
      result = await provider.send(sendPayload);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return result;
}

function renderPayload(
  template: TemplateDef<unknown> | undefined,
  channel: Channel,
  validatedInput: unknown,
  payload: InputPayload,
  record: MessageRecord,
  id: string
): { sendPayload?: AnyRendered & OutboundMeta; error?: string } {
  try {
    const rendered = template
      ? renderValidated(template, channel, validatedInput, payload.locale ?? 'en')
      : ({} as AnyRendered);
    const meta: OutboundMeta = {
      to: payload.to ?? '',
      messageId: id,
      template: record.template,
      kind: record.kind,
      locale: payload.locale ?? 'en',
    };
    return { sendPayload: { ...meta, ...rendered } as AnyRendered & OutboundMeta };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function performChannelAttempt(
  provider: Provider<AnyRendered> | undefined,
  template: TemplateDef<unknown> | undefined,
  channel: Channel,
  validatedInput: unknown,
  payload: InputPayload,
  record: MessageRecord,
  id: string
): Promise<Attempt> {
  if (!provider) {
    return {
      channel,
      provider: NO_PROVIDER,
      status: 'failed',
      error: `No provider configured for channel "${channel}"`,
      at: new Date().toISOString(),
    };
  }

  const base = { channel, provider: provider.name };
  const { sendPayload, error } = renderPayload(
    template,
    channel,
    validatedInput,
    payload,
    record,
    id
  );

  if (error || !sendPayload) {
    return {
      ...base,
      status: 'failed',
      error: error ?? 'Template rendering failed',
      at: new Date().toISOString(),
    };
  }

  const result = await attemptSend(provider, sendPayload);
  const at = new Date().toISOString();
  return result.ok
    ? {
        ...base,
        status: 'sent',
        ...(result.providerId && { providerId: result.providerId }),
        at,
      }
    : {
        ...base,
        status: 'failed',
        error: result.error
          ? scrubError(result.error, [sendPayload, validatedInput, payload.input])
          : undefined,
        at,
      };
}

async function finalizeExhaustion(
  args: AdvanceChainArgs,
  record: MessageRecord,
  attempts: Attempt[],
  lastAttemptChannel: Channel,
  lastAttemptProvider: string,
  kv: KVNamespace | undefined
): Promise<void> {
  const overallStatus = deriveOverallStatus(
    record.policy,
    { status: 'failed', attempts },
    record.always
  );

  await args.store.update(args.id, (rec) => ({
    ...rec,
    chain: {
      ...rec.chain,
      status: 'failed',
      attempts,
    },
    status: overallStatus,
    updatedAt: new Date().toISOString(),
  }));

  if (args.options.onStatus) {
    await notifyStatus(args.options.onStatus, {
      id: args.id,
      channel: lastAttemptChannel,
      provider: lastAttemptProvider,
      status: 'failed',
    });
  }

  cancelTimer(args.env, args.options.timer, args.id);
  await deleteKVInput(kv, args.id);
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

async function recordSentAttempt(
  args: AdvanceChainArgs,
  currentRecord: MessageRecord,
  attempts: Attempt[],
  attempt: Attempt,
  payload: InputPayload
): Promise<void> {
  const overallStatus = deriveOverallStatus(
    currentRecord.policy,
    { status: 'sent', attempts },
    currentRecord.always
  );

  await args.store.update(args.id, (rec) => ({
    ...rec,
    chain: {
      ...rec.chain,
      status: 'sent',
      attempts,
    },
    status: overallStatus,
    updatedAt: attempt.at,
  }));

  const fallbackTimeoutMs = args.options.fallbackTimeoutMs ?? 10_000;
  rearmTimer(args.env, args.options.timer, args.id, fallbackTimeoutMs, payload);
}

async function executeFallbackLoop(
  args: AdvanceChainArgs,
  initialRecord: MessageRecord,
  nextChannels: Channel[],
  payload: InputPayload,
  template: TemplateDef<unknown> | undefined,
  validatedInput: unknown,
  kv: KVNamespace | undefined
): Promise<void> {
  let currentRecord = initialRecord;

  for (const [index, channel] of nextChannels.entries()) {
    const provider = findProviderForChannel(args.options.providers, args.env, channel);
    const attempt = await performChannelAttempt(
      provider,
      template,
      channel,
      validatedInput,
      payload,
      initialRecord,
      args.id
    );

    const attempts = [...currentRecord.chain.attempts, attempt];

    if (attempt.providerId) {
      try {
        await args.store.indexProviderId(attempt.providerId, {
          id: args.id,
          channel: attempt.channel,
          provider: attempt.provider,
        });
      } catch {
        // ignore indexing error
      }
    }

    if (args.options.onStatus) {
      await notifyStatus(args.options.onStatus, {
        id: args.id,
        channel: attempt.channel,
        provider: attempt.provider,
        status: attempt.status,
      });
    }

    if (attempt.status === 'sent') {
      await recordSentAttempt(args, currentRecord, attempts, attempt, payload);
      return;
    }

    currentRecord = {
      ...currentRecord,
      chain: {
        ...currentRecord.chain,
        attempts,
      },
    };

    if (index === nextChannels.length - 1) {
      await finalizeExhaustion(
        args,
        currentRecord,
        attempts,
        attempt.channel,
        attempt.provider,
        kv
      );
      return;
    }

    await args.store.update(args.id, (rec) => ({
      ...rec,
      chain: {
        ...rec.chain,
        attempts,
      },
      updatedAt: attempt.at,
    }));
  }
}

/**
 * Advances delivery fallback chain when an attempt fails or times out.
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
    await finalizeExhaustion(
      args,
      initialRecord,
      [...initialRecord.chain.attempts],
      lastAttempt.channel,
      lastAttempt.provider,
      kv
    );
    return;
  }

  const payload = await resolveInputPayload(args, kv);
  const template = resolveTemplate(args.options.templates, initialRecord.template);
  const validatedInput = template ? validateInput(template, payload.input) : payload.input;

  await executeFallbackLoop(
    args,
    initialRecord,
    nextChannels,
    payload,
    template,
    validatedInput,
    kv
  );
}
