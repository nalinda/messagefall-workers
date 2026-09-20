/**
 * The send pipeline: validate, resolve policy, create the record, dispatch to providers
 * and record attempts.
 *
 * @module
 */

import type {
  Channel,
  OutboundMeta,
  Provider,
  RenderedEmail,
  RenderedSms,
  RenderedWhatsApp,
  SendResult,
} from '../providers/types.js';
import {
  type AnyRendered,
  definedChannels,
  render,
  type TemplateDef,
  validateTemplateInput,
} from '../templates.js';
import { type DeliveryOverride, type DeliveryPolicy, resolveDelivery } from './policy.js';
import {
  type Attempt,
  deriveOverallStatus,
  type MessageRecord,
  type StatusStore,
} from './status.js';

/**
 * E.164 phone number: a `+`, a non-zero leading digit and up to 14 more digits.
 */
export const E164 = /^\+[1-9]\d{1,14}$/;

/**
 * Thrown when `to` is not an E.164 phone number.
 */
export class RecipientError extends Error {
  readonly to: string;

  constructor(to: string) {
    super('Recipient must be an E.164 phone number (e.g. +14155550123)');
    this.name = 'RecipientError';
    this.to = to;
  }
}

/**
 * Provider set built from env, one provider per channel at most.
 */
export interface ProviderSet {
  whatsapp?: Provider<RenderedWhatsApp>;
  sms?: Provider<RenderedSms>;
  email?: Provider<RenderedEmail>;
}

/**
 * Status event handed to `onStatus` after each attempt is recorded.
 */
export interface StatusCallbackEvent {
  id: string;
  channel: Channel;
  provider: string;
  status: Attempt['status'];
}

/**
 * Minimal ExecutionContext shape used by the pipeline.
 */
export interface SendContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Everything the pipeline needs that is fixed per messaging instance.
 */
export interface SendDeps {
  providers: ProviderSet;
  store: StatusStore;
  defaults: DeliveryPolicy;
  onStatus?: (event: StatusCallbackEvent) => void | Promise<void>;
}

/**
 * Per-send arguments.
 */
export interface SendRequest {
  templateName: string;
  template: TemplateDef<unknown>;
  to: string;
  locale: string;
  input: unknown;
  delivery?: DeliveryOverride;
}

function newMessageId(): string {
  return `msg_${crypto.randomUUID().replaceAll('-', '')}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerFor(providers: ProviderSet, channel: Channel): Provider<AnyRendered> | undefined {
  switch (channel) {
    case 'whatsapp': {
      return providers.whatsapp;
    }
    case 'sms': {
      return providers.sms;
    }
    case 'email': {
      return providers.email;
    }
  }
}

async function callProvider(
  provider: Provider<AnyRendered>,
  payload: AnyRendered & OutboundMeta
): Promise<SendResult> {
  try {
    return await provider.send(payload);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Renders and sends one channel, retrying a retryable failure exactly once.
 */
async function attemptChannel(
  req: SendRequest,
  id: string,
  providers: ProviderSet,
  channel: Channel
): Promise<Attempt> {
  const provider = providerFor(providers, channel);
  if (!provider) {
    return {
      channel,
      provider: 'none',
      status: 'failed',
      error: `No provider configured for channel "${channel}"`,
      at: new Date().toISOString(),
    };
  }
  const base = { channel, provider: provider.name };
  let payload: AnyRendered & OutboundMeta;
  try {
    const rendered: AnyRendered = render(req.template, channel, req.input, req.locale);
    const meta: OutboundMeta = {
      to: req.to,
      messageId: id,
      template: req.templateName,
      kind: req.template.kind,
      locale: req.locale,
    };
    // Spread meta first so a rendered WhatsApp `template` config ({ name, language, params })
    // is never overwritten by OutboundMeta.template (the catalogue name).
    payload = { ...meta, ...rendered } as AnyRendered & OutboundMeta;
  } catch (error) {
    return { ...base, status: 'failed', error: errorMessage(error), at: new Date().toISOString() };
  }

  let result = await callProvider(provider, payload);
  if (!result.ok && result.retryable) {
    result = await callProvider(provider, payload);
  }

  const at = new Date().toISOString();
  return result.ok
    ? { ...base, status: 'sent', ...(result.providerId && { providerId: result.providerId }), at }
    : { ...base, status: 'failed', error: result.error, at };
}

/**
 * Walks the fallback chain in order until one channel accepts the message.
 *
 * Seam for #7: this covers only failures the provider reports synchronously. The async
 * path (a `failed` delivery status arriving by webhook, or a timer expiry from #8) resumes
 * from `record.chain.attempts.length` as the index into `policy.fallback` and reuses
 * `attemptChannel` + `chainStatus` to advance and re-derive the record.
 */
async function runChain(
  req: SendRequest,
  id: string,
  providers: ProviderSet,
  fallback: Channel[]
): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  for (const channel of fallback) {
    const attempt = await attemptChannel(req, id, providers, channel);
    attempts.push(attempt);
    if (attempt.status !== 'failed') {
      break;
    }
  }
  return attempts;
}

function settled<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === 'fulfilled' ? result.value : fallback;
}

function chainStatus(attempts: Attempt[], fallback: Channel[]): MessageRecord['chain']['status'] {
  if (attempts.length === 0 || fallback.length === 0) {
    return 'pending';
  }
  return attempts.at(-1)!.status;
}

async function deliver(deps: SendDeps, req: SendRequest, id: string, policy: DeliveryPolicy) {
  const chainTask =
    policy.fallback.length > 0 ? runChain(req, id, deps.providers, policy.fallback) : null;
  const alwaysTasks = policy.always.map((channel) =>
    attemptChannel(req, id, deps.providers, channel)
  );

  const [chainResult, ...alwaysResults] = await Promise.allSettled([
    chainTask ?? Promise.resolve<Attempt[]>([]),
    ...alwaysTasks,
  ]);
  const chainAttempts = settled(chainResult, []);
  const alwaysAttempts = alwaysResults.map((result, i) =>
    settled<Attempt>(result, {
      channel: policy.always.at(i)!,
      provider: providerFor(deps.providers, policy.always.at(i)!)?.name ?? 'none',
      status: 'failed',
      error: 'attempt did not settle',
      at: new Date().toISOString(),
    })
  );

  await deps.store.update(id, (record) => {
    const chain = {
      status: chainStatus(chainAttempts, policy.fallback),
      attempts: [...record.chain.attempts, ...chainAttempts],
    };
    const always = [...record.always, ...alwaysAttempts];
    return {
      ...record,
      chain,
      always,
      status: deriveOverallStatus(policy, chain, always),
      updatedAt: new Date().toISOString(),
    };
  });

  for (const attempt of [...chainAttempts, ...alwaysAttempts]) {
    await observe(deps, id, attempt);
  }
}

/**
 * Indexes the providerId and notifies `onStatus` for one attempt. Both are observers of a
 * send that has already happened, so their failures are logged (without content) and swallowed
 * rather than allowed to fail the send.
 */
async function observe(deps: SendDeps, id: string, attempt: Attempt): Promise<void> {
  const { channel, provider, status } = attempt;
  if (attempt.providerId) {
    try {
      await deps.store.indexProviderId(attempt.providerId, { id, channel, provider });
    } catch {
      console.warn(`[messagefall] indexProviderId failed id=${id} channel=${channel}`);
    }
  }
  try {
    await deps.onStatus?.({ id, channel, provider, status });
  } catch {
    console.warn(`[messagefall] onStatus failed id=${id} channel=${channel}`);
  }
}

/**
 * Runs the send pipeline for one message.
 *
 * Validates the recipient and input, resolves the delivery policy, creates the pending record
 * and dispatches to the first fallback channel and every always channel in parallel. OTP sends
 * with an ExecutionContext defer dispatch to `ctx.waitUntil` and resolve once the record exists.
 *
 * @param deps - Providers, status store, default policy and status callback.
 * @param req - The send request.
 * @param ctx - Optional execution context.
 * @returns The new message id.
 */
export async function runSend(
  deps: SendDeps,
  req: SendRequest,
  ctx?: SendContext
): Promise<{ id: string }> {
  if (!E164.test(req.to)) {
    throw new RecipientError(req.to);
  }
  const input = validateTemplateInput(req.template, req.input);
  const validated: SendRequest = { ...req, input };

  const policy = resolveDelivery({
    defaults: deps.defaults,
    template: req.template.delivery,
    send: req.delivery,
    defined: definedChannels(req.template),
    templateName: req.templateName,
  });
  const id = newMessageId();
  const now = new Date().toISOString();
  await deps.store.create({
    id,
    template: req.templateName,
    kind: req.template.kind,
    policy,
    chain: { status: 'pending', attempts: [] },
    always: [],
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  });

  const work = deliver(deps, validated, id, policy);
  if (ctx && req.template.kind === 'otp') {
    ctx.waitUntil(work);
  } else {
    await work;
  }
  return { id };
}
