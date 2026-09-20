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
  assertNoOtpWhatsAppText,
  definedChannels,
  renderValidated,
  type TemplateDef,
  validateInput,
} from '../templates.js';
import { createLogger } from './logger.js';
import { type DeliveryOverride, type DeliveryPolicy, resolveDelivery } from './policy.js';
import { scrubError } from './redact.js';
import {
  type Attempt,
  deriveOverallStatus,
  type MessageRecord,
  MessageRecordNotFoundError,
  type StatusStore,
} from './status.js';
import { ulid } from './ulid.js';

const defaultLogger = createLogger();

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
  email?: string;
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
      to: channel === 'email' ? (req.email ?? req.to) : req.to,
      messageId: id,
      template: req.templateName,
      kind: req.template.kind,
      locale: req.locale,
    };
    // See #28 — OutboundMeta.template / RenderedWhatsApp.template collision; rendered wins.
    payload = { ...meta, ...rendered } as AnyRendered & OutboundMeta;
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      error: scrubError(errorMessage(error), [req.validatedInput, req.input]),
      at: new Date().toISOString(),
    };
  }

  let result = await callProvider(provider, payload);
  if (!result.ok && result.retryable) {
    defaultLogger.warn('send.retry', {
      id,
      channel,
      provider: provider.name,
      errorCode: (result as { errorCode?: string }).errorCode,
    });
    result = await callProvider(provider, payload);
  }

  const at = new Date().toISOString();
  return result.ok
    ? { ...base, status: 'sent', ...(result.providerId && { providerId: result.providerId }), at }
    : {
        ...base,
        status: 'failed',
        error: result.error
          ? scrubError(result.error, [payload, req.validatedInput, req.input])
          : undefined,
        at,
      };
}

/**
 * How far the chain walk has actually got, independent of which attempts landed on the record.
 * `attempted` counts channels tried; `last` is the outcome of the most recent one.
 */
export interface ChainProgress {
  attempted: number;
  last: Attempt['status'];
}

/**
 * Persists one attempt as soon as it settles. Called by `runChain` for chain attempts (with the
 * walk's progress) and by `deliver` for always attempts.
 */
export type RecordAttempt = (
  attempt: Attempt,
  part: 'chain' | 'always',
  progress?: ChainProgress
) => Promise<void>;

/**
 * Recorder for one send: `record` persists attempts; `sealChain` re-derives the chain status
 * from `progress` alone, for when a chain attempt's own write was lost.
 */
export interface AttemptRecorder {
  record: RecordAttempt;
  sealChain(progress: ChainProgress): Promise<void>;
}

/**
 * Walks `fallback` in order, one attempt per channel, until a channel accepts the message,
 * persisting each attempt through `record` as it settles. Returns every attempt made (all but
 * the last are `failed`).
 *
 * This is THE chain-advance logic; do not write a second one. It only sees failures the
 * provider reports synchronously. The asynchronous path (#7: a `failed` delivery status from a
 * webhook; #8: the fallback timer firing) must reuse it by calling `runChain` again with the
 * remaining channels, `policy.fallback.slice(record.chain.attempts.length)`, and a recorder
 * built with `attemptRecorder` (which appends the attempt, recomputes `chainStatus` and
 * `deriveOverallStatus`, indexes the providerId and notifies `onStatus`).
 *
 * Inputs for that async path: `runChain` needs a `ValidatedSendRequest` (to, locale, validated
 * input). The `MessageRecord` deliberately carries none of them. Per #7's own acceptance
 * criterion they live in a separate KV key, `in:<id>`, written on send with a TTL matching the
 * chain timeout and deleted once the chain reaches a terminal state; #7's fallback path reads
 * it (or takes a synchronous `input` pass-through) to rebuild the render with `validateInput` +
 * `renderValidated`. The `in:<id>` write is part of #7's scope and is not done here yet.
 */
export async function runChain(
  req: ValidatedSendRequest,
  id: string,
  providers: ProviderSet,
  fallback: Channel[],
  recorder: AttemptRecorder
): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  let persistError: Error | undefined;
  let progress: ChainProgress | undefined;
  for (const channel of fallback) {
    const attempt = await attemptChannel(req, id, providers, channel);
    attempts.push(attempt);
    progress = { attempted: attempts.length, last: attempt.status };
    try {
      await recorder.record(attempt, 'chain', progress);
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
    // A lost write must not leave the chain looking unfinished: re-derive its status from how
    // far the walk actually got. Best effort; the original error is what the caller sees. A
    // missing record cannot be sealed.
    if (progress && !(persistError instanceof MessageRecordNotFoundError)) {
      try {
        await recorder.sealChain(progress);
      } catch {
        // the persist error below already covers this
      }
    }
    throw persistError;
  }
  return attempts;
}

/**
 * Chain status from the attempts on the record plus, when known, the walk's actual progress
 * (attempts whose write was lost still count as attempted). A `failed` tail is terminal only
 * once every configured fallback channel has been attempted; until then the chain is `pending`.
 */
function chainStatus(
  attempts: Attempt[],
  fallback: Channel[],
  progress?: ChainProgress
): MessageRecord['chain']['status'] {
  if (fallback.length === 0) {
    return 'pending';
  }
  const attempted = Math.max(attempts.length, progress?.attempted ?? 0);
  const last = progress?.last ?? attempts.at(-1)?.status;
  if (last === undefined) {
    return 'pending';
  }
  if (last === 'failed' && attempted < fallback.length) {
    return 'pending';
  }
  return last;
}

/**
 * One `store.update`, retried once for transient failures. A missing record is not transient,
 * so `MessageRecordNotFoundError` propagates without the extra KV round-trip.
 */
async function updateWithRetry(
  deps: SendDeps,
  id: string,
  fn: (record: MessageRecord) => MessageRecord
): Promise<void> {
  try {
    await deps.store.update(id, fn);
  } catch (error) {
    if (error instanceof MessageRecordNotFoundError) {
      throw error;
    }
    await deps.store.update(id, fn);
  }
}

/**
 * Builds the recorder for one send. `record` appends the attempt to the right part of the
 * record, re-derives chain/overall status, then indexes the providerId and notifies `onStatus`;
 * `sealChain` only re-derives the status. Updates are queued so chain and always attempts
 * settling in the same tick never overwrite each other's write to the same record. Mutators
 * always return fresh objects, so a retried update is idempotent.
 *
 * @param deps - Store and callbacks.
 * @param id - Message id.
 * @param policy - Resolved policy (chain status derivation depends on it).
 * @returns The recorder to hand to `runChain` / always attempts.
 */
export function attemptRecorder(
  deps: SendDeps,
  id: string,
  policy: DeliveryPolicy
): AttemptRecorder {
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (run: () => Promise<void>): Promise<void> => {
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

  /**
   * Rebuilds the record with a new chain and/or always part. Only chain-part writes recompute
   * `chain.status`; an always write keeps whatever the chain last said, so a sealed terminal
   * chain status is never resurrected by a late always attempt.
   */
  const rederive = (
    record: MessageRecord,
    chain: MessageRecord['chain'],
    always: Attempt[]
  ): MessageRecord => ({
    ...record,
    chain,
    always,
    status: deriveOverallStatus(policy, chain, always),
    updatedAt: new Date().toISOString(),
  });

  const chainPart = (attempts: Attempt[], progress?: ChainProgress): MessageRecord['chain'] => ({
    attempts,
    status: chainStatus(attempts, policy.fallback, progress),
  });

  return {
    record: (attempt, part, progress) =>
      enqueue(async () => {
        await updateWithRetry(deps, id, (record) =>
          part === 'chain'
            ? rederive(record, chainPart([...record.chain.attempts, attempt], progress), [
                ...record.always,
              ])
            : rederive(record, { ...record.chain, attempts: [...record.chain.attempts] }, [
                ...record.always,
                attempt,
              ])
        );
        await indexAttempt(deps, id, attempt);
        // Observers run off the write queue: a slow onStatus must not stall the next attempt's
        // record write or the chain seal. notifyStatus already contains the observer's errors.
        void notifyStatus(deps.onStatus, {
          id,
          channel: attempt.channel,
          provider: attempt.provider,
          status: attempt.status,
        });
      }),
    sealChain: (progress) =>
      enqueue(() =>
        updateWithRetry(deps, id, (record) =>
          rederive(record, chainPart([...record.chain.attempts], progress), [...record.always])
        )
      ),
  };
}

async function deliver(
  deps: SendDeps,
  req: ValidatedSendRequest,
  id: string,
  policy: DeliveryPolicy
): Promise<void> {
  const recorder = attemptRecorder(deps, id, policy);
  const chainTask =
    policy.fallback.length > 0
      ? runChain(req, id, deps.providers, policy.fallback, recorder)
      : Promise.resolve<Attempt[]>([]);
  const alwaysTasks = policy.always.map(async (channel) => {
    const attempt = await attemptChannel(req, id, deps.providers, channel);
    await recorder.record(attempt, 'always');
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
  } catch {
    defaultLogger.error('send.attempt', { id });
  }
}

/**
 * Indexes the providerId of one attempt. The send has already happened, so a failure is logged
 * (without content) and swallowed rather than allowed to fail the send.
 */
async function indexAttempt(deps: SendDeps, id: string, attempt: Attempt): Promise<void> {
  const { channel, provider } = attempt;
  if (!attempt.providerId) {
    return;
  }
  try {
    await deps.store.indexProviderId(attempt.providerId, { id, channel, provider });
  } catch {
    defaultLogger.warn('send.attempt', { id, channel, provider });
  }
}

/**
 * Calls the caller's `onStatus` observer for one event. The observer is never allowed to fail
 * the work that produced the event: an error is logged without message content and swallowed.
 * Shared by the send path and the webhook bridge in `createMessaging`.
 *
 * @param onStatus - The configured observer, if any.
 * @param event - The event to report.
 */
export async function notifyStatus(
  onStatus: SendDeps['onStatus'],
  event: StatusCallbackEvent
): Promise<void> {
  try {
    await onStatus?.(event);
  } catch {
    defaultLogger.warn('send.attempt', {
      id: event.id,
      channel: event.channel,
      provider: event.provider,
    });
  }
}

function validateSendRequest(req: SendRequest): void {
  if (!E164.test(req.to)) {
    throw new RecipientError(req.to);
  }
  assertNoOtpWhatsAppText(req.templateName, req.template);
}

function resolveEffectivePolicy(
  defaults: DeliveryPolicy,
  req: SendRequest
): { policy: DeliveryPolicy; hasSkippedEmail: boolean } {
  const initialPolicy = resolveDelivery({
    defaults,
    template: req.template.delivery,
    send: req.delivery,
    defined: definedChannels(req.template),
    templateName: req.templateName,
  });

  const hasEmail = typeof req.email === 'string' && req.email.trim().length > 0;
  const hasEmailInPolicy =
    initialPolicy.fallback.includes('email') || initialPolicy.always.includes('email');
  const hasSkippedEmail = hasEmailInPolicy && !hasEmail;

  const policy: DeliveryPolicy = hasSkippedEmail
    ? {
        fallback: initialPolicy.fallback.filter((ch) => ch !== 'email'),
        always: initialPolicy.always.filter((ch) => ch !== 'email'),
      }
    : initialPolicy;

  return { policy, hasSkippedEmail };
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
  validateSendRequest(req);
  const validated: ValidatedSendRequest = {
    ...req,
    validatedInput: validateInput(req.template, req.input),
  };

  const { policy, hasSkippedEmail } = resolveEffectivePolicy(deps.defaults, req);
  const id = newMessageId();

  if (hasSkippedEmail) {
    defaultLogger.info('send.channel-skipped', {
      id,
      channel: 'email',
      template: req.templateName,
      kind: req.template.kind,
    });
  }

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
