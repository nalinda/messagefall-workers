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
  MessageRecordNotFoundError,
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
 * `deriveOverallStatus`, and calls `observe`).
 *
 * Caveat for that async path: `runChain` needs a `ValidatedSendRequest` (to, locale, validated
 * input), and none of those are persisted on the `MessageRecord` — deliberately, because for an
 * OTP send the input holds the one-time code and #10 forbids storing it. #7/#8 therefore cannot
 * rebuild the render from the stored record as things stand; they must either persist a
 * redacted/derived form of what a resume needs, or take a different approach. That decision is
 * theirs, not #3's.
 *
 * `fallback` here is the slice being walked; `offset` is how many chain channels were already
 * attempted before it (0 for a fresh send), so progress counts against the whole policy.
 */
export async function runChain(
  req: ValidatedSendRequest,
  id: string,
  providers: ProviderSet,
  fallback: Channel[],
  recorder: AttemptRecorder,
  offset = 0
): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  let persistError: Error | undefined;
  let progress: ChainProgress | undefined;
  for (const channel of fallback) {
    const attempt = await attemptChannel(req, id, providers, channel);
    attempts.push(attempt);
    progress = { attempted: offset + attempts.length, last: attempt.status };
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

  const rederive = (
    record: MessageRecord,
    chainAttempts: Attempt[],
    always: Attempt[],
    progress?: ChainProgress
  ): MessageRecord => {
    const chain = {
      attempts: chainAttempts,
      status: chainStatus(chainAttempts, policy.fallback, progress),
    };
    return {
      ...record,
      chain,
      always,
      status: deriveOverallStatus(policy, chain, always),
      updatedAt: new Date().toISOString(),
    };
  };

  return {
    record: (attempt, part, progress) =>
      enqueue(async () => {
        await updateWithRetry(deps, id, (record) =>
          rederive(
            record,
            part === 'chain' ? [...record.chain.attempts, attempt] : [...record.chain.attempts],
            part === 'always' ? [...record.always, attempt] : [...record.always],
            progress
          )
        );
        await observe(deps, id, attempt);
      }),
    sealChain: (progress) =>
      enqueue(() =>
        updateWithRetry(deps, id, (record) =>
          rederive(record, [...record.chain.attempts], [...record.always], progress)
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
