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
  renderValidated,
  type TemplateDef,
  validateInput,
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
 * Per-send arguments. `input` is the raw payload; the pipeline validates it once and renders
 * from the validated value.
 */
export interface SendRequest {
  templateName: string;
  template: TemplateDef<unknown>;
  to: string;
  locale: string;
  input: unknown;
  delivery?: DeliveryOverride;
}

/**
 * A send request whose `input` has already passed {@link validateInput}.
 */
export interface ValidatedSendRequest extends SendRequest {
  validatedInput: unknown;
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
  req: ValidatedSendRequest,
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
    const rendered: AnyRendered = renderValidated(
      req.template,
      channel,
      req.validatedInput,
      req.locale
    );
    const meta: OutboundMeta = {
      to: req.to,
      messageId: id,
      template: req.templateName,
      kind: req.template.kind,
      locale: req.locale,
    };
    // KNOWN TYPE COLLISION, inherited from #18's Provider contract (`R & OutboundMeta`):
    // OutboundMeta.template is the catalogue name (string) while RenderedWhatsApp.template is
    // the Meta config object ({ name, language, params }). The rendered payload intentionally
    // wins, because a WhatsApp provider cannot send without the config, so `meta` is spread
    // first. Any provider that reads `message.template` must handle BOTH a string and that
    // object (see consoleProvider's templateLabel). The catalogue name is always available on
    // the MessageRecord. Fixing the contract itself is out of #3's scope.
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
 * Walks `fallback` in order, one attempt per channel, until a channel accepts the message.
 * Returns every attempt made (all but the last are `failed`).
 *
 * This is THE chain-advance logic; do not write a second one. It only sees failures the
 * provider reports synchronously. The asynchronous path (#7: a `failed` delivery status from a
 * webhook; #8: the fallback timer firing) must reuse it by calling `runChain` again with the
 * remaining channels, `policy.fallback.slice(record.chain.attempts.length)`, then appending the
 * returned attempts, recomputing `chainStatus(...)` and `deriveOverallStatus(...)` on the
 * record, and calling `observe` for each new attempt — exactly as `deliver` does below. The
 * rendered payload is rebuilt from the stored template/input via `validateInput` +
 * `renderValidated`, the same helpers `attemptChannel` uses.
 */
export async function runChain(
  req: ValidatedSendRequest,
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

function chainStatus(attempts: Attempt[], fallback: Channel[]): MessageRecord['chain']['status'] {
  if (attempts.length === 0 || fallback.length === 0) {
    return 'pending';
  }
  return attempts.at(-1)!.status;
}

async function deliver(
  deps: SendDeps,
  req: ValidatedSendRequest,
  id: string,
  policy: DeliveryPolicy
): Promise<void> {
  const chainTask =
    policy.fallback.length > 0 ? runChain(req, id, deps.providers, policy.fallback) : null;
  const alwaysTasks = policy.always.map((channel) =>
    attemptChannel(req, id, deps.providers, channel)
  );

  // attemptChannel/runChain settle every failure into an Attempt themselves, so allSettled is
  // used only to await the chain and the always channels in parallel.
  const [chainAttempts, ...alwaysAttempts] = await Promise.all([
    chainTask ?? Promise.resolve<Attempt[]>([]),
    ...alwaysTasks,
  ]);

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
 * Marks a record failed after delivery blew up part-way (providers were already called). Best
 * effort: a second store failure is logged and swallowed. The chain status is only touched when
 * the policy has a chain, matching `chainStatus`'s rule for always-only policies.
 */
async function markFailed(deps: SendDeps, id: string, policy: DeliveryPolicy): Promise<void> {
  try {
    await deps.store.update(id, (record) => ({
      ...record,
      chain: policy.fallback.length > 0 ? { ...record.chain, status: 'failed' } : record.chain,
      status: 'failed',
      updatedAt: new Date().toISOString(),
    }));
  } catch {
    console.error(`[messagefall] could not mark record failed id=${id}`);
  }
}

/**
 * Runs `deliver` and contains its failure: providers have been called by the time anything in
 * `deliver` can throw (the store update), so the error is logged without message content and
 * the record is marked failed rather than left `pending` forever. Never rejects, which makes it
 * safe for both the inline and the `ctx.waitUntil` path.
 */
async function deliverGuarded(
  deps: SendDeps,
  req: ValidatedSendRequest,
  id: string,
  policy: DeliveryPolicy
): Promise<void> {
  try {
    await deliver(deps, req, id, policy);
  } catch (error) {
    console.error(`[messagefall] delivery failed id=${id}: ${errorMessage(error)}`);
    await markFailed(deps, id, policy);
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
  const validated: ValidatedSendRequest = {
    ...req,
    validatedInput: validateInput(req.template, req.input),
  };

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

  if (ctx && req.template.kind === 'otp') {
    ctx.waitUntil(deliverGuarded(deps, validated, id, policy));
  } else {
    await deliverGuarded(deps, validated, id, policy);
  }
  return { id };
}
