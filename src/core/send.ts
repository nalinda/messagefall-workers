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
import { ulid } from './ulid.js';

/**
 * `Attempt.provider` value recorded when a resolved channel has no provider configured.
 */
export const NO_PROVIDER = 'none';

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
  return `msg_${ulid()}`;
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
      provider: NO_PROVIDER,
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
    // See #28 — OutboundMeta.template / RenderedWhatsApp.template collision; rendered wins.
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
 * Persists one attempt as soon as it settles. Called by `runChain` for chain attempts and by
 * `deliver` for always attempts.
 */
export type RecordAttempt = (attempt: Attempt, part: 'chain' | 'always') => Promise<void>;

/**
 * Walks `fallback` in order, one attempt per channel, until a channel accepts the message,
 * persisting each attempt through `record` as it settles. Returns every attempt made (all but
 * the last are `failed`).
 *
 * This is THE chain-advance logic; do not write a second one. It only sees failures the
 * provider reports synchronously. The asynchronous path (#7: a `failed` delivery status from a
 * webhook; #8: the fallback timer firing) must reuse it by calling `runChain` again with the
 * remaining channels, `policy.fallback.slice(record.chain.attempts.length)`, and a `record`
 * callback built with `attemptRecorder` (which appends the attempt, recomputes `chainStatus`
 * and `deriveOverallStatus`, and calls `observe`). The rendered payload is rebuilt from the
 * stored template/input via `validateInput` + `renderValidated`, the same helpers
 * `attemptChannel` uses.
 */
export async function runChain(
  req: ValidatedSendRequest,
  id: string,
  providers: ProviderSet,
  fallback: Channel[],
  record: RecordAttempt
): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  let persistError: Error | undefined;
  for (const channel of fallback) {
    const attempt = await attemptChannel(req, id, providers, channel);
    attempts.push(attempt);
    try {
      await record(attempt, 'chain');
    } catch (error) {
      // Persisting and advancing are independent: keep walking the chain, surface the
      // first write failure once the chain has been exhausted or accepted.
      persistError ??= error instanceof Error ? error : new Error(errorMessage(error));
    }
    if (attempt.status !== 'failed') {
      break;
    }
  }
  if (persistError !== undefined) {
    throw persistError;
  }
  return attempts;
}

/**
 * Chain status from the attempts recorded so far. A `failed` tail is only terminal once every
 * configured fallback channel has been attempted; until then the chain is still `pending`.
 */
function chainStatus(attempts: Attempt[], fallback: Channel[]): MessageRecord['chain']['status'] {
  if (attempts.length === 0 || fallback.length === 0) {
    return 'pending';
  }
  const last = attempts.at(-1)!.status;
  if (last === 'failed' && attempts.length < fallback.length) {
    return 'pending';
  }
  return last;
}

/**
 * One `store.update`, retried once. KV is last-writer-wins, so a transient failure is retried
 * before the caller gives up; the second failure propagates.
 */
async function updateWithRetry(
  deps: SendDeps,
  id: string,
  fn: (record: MessageRecord) => MessageRecord
): Promise<void> {
  try {
    await deps.store.update(id, fn);
  } catch {
    await deps.store.update(id, fn);
  }
}

/**
 * Builds the `RecordAttempt` callback for one send: appends the attempt to the right part of
 * the record, re-derives chain/overall status, then indexes the providerId and notifies
 * `onStatus`. Updates are queued so chain and always attempts settling in the same tick never
 * overwrite each other's write to the same record.
 *
 * @param deps - Store and callbacks.
 * @param id - Message id.
 * @param policy - Resolved policy (chain status derivation depends on it).
 * @returns The recorder to hand to `runChain` / always attempts.
 */
export function attemptRecorder(deps: SendDeps, id: string, policy: DeliveryPolicy): RecordAttempt {
  let queue: Promise<void> = Promise.resolve();
  return (attempt, part) => {
    const run = async (): Promise<void> => {
      await updateWithRetry(deps, id, (record) => {
        const chain =
          part === 'chain'
            ? { ...record.chain, attempts: [...record.chain.attempts, attempt] }
            : record.chain;
        chain.status = chainStatus(chain.attempts, policy.fallback);
        const always = part === 'always' ? [...record.always, attempt] : record.always;
        return {
          ...record,
          chain,
          always,
          status: deriveOverallStatus(policy, chain, always),
          updatedAt: new Date().toISOString(),
        };
      });
      await observe(deps, id, attempt);
    };
    // Chain the work regardless of an earlier failure so later attempts are still persisted;
    // each caller awaits (and handles) its own returned promise.
    const previous = queue;
    const next = (async (): Promise<void> => {
      try {
        await previous;
      } catch {
        // surfaced to the earlier caller already
      }
      await run();
    })();
    queue = next;
    return next;
  };
}

async function deliver(
  deps: SendDeps,
  req: ValidatedSendRequest,
  id: string,
  policy: DeliveryPolicy
): Promise<void> {
  const record = attemptRecorder(deps, id, policy);
  const chainTask =
    policy.fallback.length > 0
      ? runChain(req, id, deps.providers, policy.fallback, record)
      : Promise.resolve<Attempt[]>([]);
  const alwaysTasks = policy.always.map(async (channel) => {
    const attempt = await attemptChannel(req, id, deps.providers, channel);
    await record(attempt, 'always');
  });

  // Every attempt is persisted and observed the moment it settles; this only waits for all of
  // them, then surfaces the first persistence failure (provider failures never reject).
  const results = await Promise.allSettled([chainTask, ...alwaysTasks]);
  const rejected = results.find((r) => r.status === 'rejected');
  if (rejected) {
    throw rejected.reason;
  }
}

/**
 * Runs `deliver` and contains its failure. Providers have been called by the time anything in
 * `deliver` can throw (a record update that failed twice), so the error is logged without
 * message content and the record is left as persisted so far: it is NOT marked failed, because
 * a message may already have gone out and a caller must not read the record as "nothing was
 * sent". Never rejects, which makes it safe for both the inline and the `ctx.waitUntil` path.
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
    console.error(
      `[messagefall] could not persist delivery status id=${id}; attempts may have been sent, do not assume nothing happened: ${errorMessage(error)}`
    );
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
