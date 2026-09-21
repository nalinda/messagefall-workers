/**
 * Fallback on failed delivery status or timeout.
 *
 * Advances delivery across configured fallback channels when a channel fails
 * or times out.
 *
 * The chain walk itself is NOT implemented here: this module resolves the remaining channels
 * and the render inputs, normalises the providers through `./provider-set.js`, then hands them
 * to `runChain` / `attemptRecorder` in `./send.js`, which is the single chain-advance
 * implementation. Everything below is the
 * asynchronous entry point's own concerns — where the input comes from (`in:<id>` in KV, the
 * timer's state, or a synchronous pass-through) and what happens to the fallback timer and the
 * `in:<id>` key once the chain settles.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import type { MessagingEnv } from '../env.js';
import type { Channel } from '../providers/types.js';
import { getTemplate, type TemplateDef, validateInput } from '../templates.js';
import type { StandardSchemaV1 } from '../types.js';
import { createLogger, type LogEvent } from './logger.js';
import type { MessagingOptions } from './messaging.js';
import { toProviderSet } from './provider-set.js';
import {
  asRenderInput,
  DEFAULT_LOCALE,
  pickRenderInput,
  readRenderInput,
  type RenderInput,
  sealAndReleaseChain,
} from './render-input.js';
import {
  attemptRecorder,
  NO_PROVIDER,
  notifyStatus,
  providerFor,
  type ProviderSet,
  runChain,
  type SendDeps,
  type StatusCallbackEvent,
  type ValidatedSendRequest,
} from './send.js';
import {
  type Attempt,
  isConfirmedDelivery,
  type MessageRecord,
  type StatusStore,
} from './status.js';
import { chainTimeoutMs, type FallbackTimerClient, resolveTimer } from './timer.js';

const logger = createLogger();

/**
 * Arguments for advancing the delivery fallback chain.
 */
export interface AdvanceChainArgs {
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
  env: MessagingEnv;
  /**
   * Messaging options containing templates, providers, onStatus, etc.
   */
  options: Omit<Partial<MessagingOptions>, 'templates' | 'providers' | 'onStatus' | 'timer'> & {
    templates?: MessagingOptions['templates'];
    providers?: ProviderSet;
    onStatus?: (event: StatusCallbackEvent) => void | Promise<void>;
    /**
     * Re-arm timeout override. When absent the record's kind selects it from
     * `options.delivery.timeout`, defaulting to 30s for `otp` and 300s for `notification`.
     */
    fallbackTimeoutMs?: number;
    kv?: KVNamespace;
    timer?: FallbackTimerClient;
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
 * Re-arms the fallback timer after a non-terminal attempt. Best effort: the attempt is already
 * recorded, so a timer that cannot be reached must not fail the advance.
 */
async function rearmTimer(
  env: MessagingEnv,
  optionsTimer: FallbackTimerClient | undefined,
  id: string,
  timeoutMs: number,
  inputPayload?: RenderInput
): Promise<void> {
  try {
    await resolveTimer(env, optionsTimer)?.arm?.(id, timeoutMs, inputPayload);
  } catch {
    // Best-effort rearming
  }
}

/**
 * Fills the fields a payload lacks from another one; what the payload defines wins.
 */
function withRecipient(payload: RenderInput, from: RenderInput | undefined): RenderInput {
  return from ? { ...pickRenderInput(from), ...pickRenderInput(payload) } : payload;
}

function extractFromTimer(
  timer: FallbackTimerClient | undefined,
  id: string
): RenderInput | undefined {
  if (typeof timer?.armed !== 'function') {
    return undefined;
  }
  const state = timer.armed(id);
  if (!state?.input) {
    return undefined;
  }
  return asRenderInput(state.input);
}

async function resolveInputPayload(
  args: AdvanceChainArgs,
  kv: KVNamespace | undefined
): Promise<RenderInput | undefined> {
  if (args.input !== undefined && args.input !== null) {
    // The timer stores input and locale but not necessarily the recipient (#8): the `in:<id>`
    // entry the send wrote fills in whatever the pass-through lacks.
    const given = asRenderInput(args.input);
    return given.to === undefined
      ? withRecipient(given, await readRenderInput(kv, args.id))
      : given;
  }

  const fromTimer = extractFromTimer(resolveTimer(args.env, args.options.timer), args.id);
  if (fromTimer) {
    return fromTimer;
  }

  return readRenderInput(kv, args.id);
}

/**
 * Whether a recovered payload can actually rebuild the send. Without a recipient there is
 * nothing to address the next channel to, and dispatching anyway would hand a real gateway a
 * blank `to`.
 */
function isRenderable(payload: RenderInput | undefined): payload is RenderInput & { to: string } {
  return payload !== undefined && typeof payload.to === 'string' && payload.to.length > 0;
}

function shouldSkipAdvancement(
  record: MessageRecord | null,
  reason: 'failed' | 'timeout'
): boolean {
  // `sealed` first, and on its own: a chain whose fallback processing already ran to the end is
  // never advanced again, whatever its status or last attempt say. `advanceChain` is exported,
  // so a caller can invoke it twice for the same terminal event; without this the second call
  // re-runs `finalizeExhaustion` and fires a duplicate terminal `onStatus`.
  if (!record || record.sealed === true) {
    return true;
  }
  if (isConfirmedDelivery(record.chain.status)) {
    return true;
  }
  const lastAttempt = record.chain.attempts.at(-1);
  if (!lastAttempt || isConfirmedDelivery(lastAttempt.status)) {
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

  await release(args, record, kv);
}

/**
 * The name the configured provider for a channel would be recorded under, or {@link NO_PROVIDER}
 * when the channel has none.
 */
function providerNameFor(providers: ProviderSet, channel: Channel): string {
  return providerFor(providers, channel)?.name ?? NO_PROVIDER;
}

/**
 * The two ways a recovered render input can turn out to be unusable, with the scrubbed message
 * each one records on the attempt. Neither carries any part of the input or of the validation
 * error: a status record is readable over `/status/:id`.
 */
interface UnusableInput {
  event: LogEvent;
  error: string;
}

const INPUT_LOST: UnusableInput = {
  event: 'fallback.input-lost',
  error: 'Render input is no longer available; the message cannot be rebuilt for fallback',
};

const INPUT_INVALID: UnusableInput = {
  event: 'fallback.input-invalid',
  error:
    'Render input no longer satisfies the template schema; the message cannot be rebuilt for fallback',
};

/**
 * Seals a chain whose render input cannot be used — either it can no longer be recovered
 * (neither the timer nor the `in:<id>` KV entry has it, because the entry expired before the
 * `failed` status arrived), or it no longer validates against the template's schema, which a
 * redeploy that tightened that schema inside the chain's timeout window will do.
 *
 * There is nothing to render from, so the next channel is recorded as a failed attempt and the
 * chain released. It is NOT dispatched: a payload rebuilt from nothing carries a blank
 * recipient, and a real gateway would accept it.
 *
 * The two reasons keep separate event names because the operator's next move differs — a lost
 * input points at the TTL or the timer, an invalid one at a schema change — but the treatment
 * has to be the same either way: an advance that simply threw would leave the chain neither
 * advanced nor sealed with its timer still armed, and on the Durable Object alarm path it would
 * come back as a platform retry that can never succeed.
 */
async function finalizeUnusableInput(
  args: AdvanceChainArgs,
  record: MessageRecord,
  providers: ProviderSet,
  nextChannel: Channel,
  kv: KVNamespace | undefined,
  reason: UnusableInput
): Promise<void> {
  logger.warn(reason.event, { id: args.id, kind: record.kind, channel: nextChannel });
  const recorder = attemptRecorder(sendDeps(args, providers, record), args.id, record.policy);
  await recorder.record(
    {
      channel: nextChannel,
      provider: providerNameFor(providers, nextChannel),
      status: 'failed',
      error: reason.error,
      at: new Date().toISOString(),
    },
    'chain',
    {
      attempted: Math.max(record.policy.fallback.length, record.chain.attempts.length + 1),
      last: 'failed',
    }
  );
  await release(args, record, kv);
}

/**
 * This module's call into the shared terminal-state cleanup, with the timer resolved the same
 * way every other path here resolves it.
 *
 * Every path that ends a chain here goes through this, so this is also where the record is
 * marked {@link MessageRecord.sealed} — the flag `shouldSkipAdvancement` reads to no-op a
 * repeated `advanceChain` for the same already-finished chain.
 */
async function release(
  args: AdvanceChainArgs,
  record: MessageRecord,
  kv: KVNamespace | undefined
): Promise<void> {
  await sealAndReleaseChain(
    args.store,
    resolveTimer(args.env, args.options.timer),
    kv,
    args.id,
    record.policy.fallback
  );
}

/**
 * `input` is required on every template, but a template that renders nothing never validates
 * anything either, so the stand-in below carries a pass-through schema.
 */
const PASS_THROUGH_INPUT: StandardSchemaV1<unknown, unknown> = {
  '~standard': {
    version: 1,
    vendor: 'messagefall-workers',
    validate: (value: unknown) => ({ value }),
  },
};

/**
 * A template with no channel rendering, used when the record names a template the caller's
 * catalogue no longer has: every channel then fails to render and is recorded as a failed
 * attempt rather than dispatched with an empty body.
 */
function missingTemplate(kind: MessageRecord['kind']): TemplateDef<unknown> {
  return { kind, input: PASS_THROUGH_INPUT };
}

/**
 * Rebuilds the `ValidatedSendRequest` that `runChain` renders from, out of the record and the
 * input payload recovered from KV / the timer / the caller.
 */
function rebuildRequest(
  record: MessageRecord,
  template: TemplateDef<unknown> | undefined,
  payload: RenderInput & { to: string }
): ValidatedSendRequest {
  const locale = payload.locale ?? DEFAULT_LOCALE;
  return {
    templateName: record.template,
    template: template ?? missingTemplate(record.kind),
    // Guaranteed by `isRenderable`: an advance with no recoverable recipient never gets here.
    to: payload.to,
    // Never defaulted to `payload.to`: an advance onto the email channel with no recovered
    // address would otherwise hand an email provider an E.164 phone number. Absent, the channel
    // is recorded as a failed attempt instead (see `attemptChannel`).
    ...(payload.email !== undefined && { email: payload.email }),
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
  // One line per chain advance, whatever triggered it (failed status or timer).
  logger.info('fallback.advance', { id: args.id, kind: initialRecord.kind });
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
  const providers = toProviderSet(args.options.providers);
  if (!isRenderable(payload)) {
    await finalizeUnusableInput(args, initialRecord, providers, nextChannels[0], kv, INPUT_LOST);
    return;
  }

  const template = getTemplate(args.options.templates, initialRecord.template);
  // `rebuildRequest` revalidates the stashed input, so it can throw here where every other
  // failure in this module is best-effort. Treated exactly as a lost input: recorded, released.
  let request: ValidatedSendRequest;
  try {
    request = rebuildRequest(initialRecord, template, payload);
  } catch {
    await finalizeUnusableInput(args, initialRecord, providers, nextChannels[0], kv, INPUT_INVALID);
    return;
  }

  const recorder = attemptRecorder(
    sendDeps(args, providers, initialRecord),
    args.id,
    initialRecord.policy
  );

  // `runChain` surfaces its first persistence failure by throwing, but only once the walk has
  // finished — the providers have already been called. `deliverGuarded` in `./send.js` contains
  // that same throw on the synchronous path; contained here too, because on the Durable Object
  // alarm path a rejection escaping `advanceChain` escapes `alarm()`, which the platform retries
  // against storage that the lost write left looking pre-advance — so `shouldSkipAdvancement`
  // would let the retry walk the SAME channel again and send a second time. Falling through to
  // `release` instead seals the record, which is what makes that retry a no-op.
  let attempts: Attempt[];
  try {
    attempts = await runChain(request, args.id, providers, nextChannels, recorder);
  } catch {
    logger.error('send.persist-failed', { id: args.id });
    // Which channel accepted is exactly what the lost write cost us, so the chain cannot be
    // re-armed for another fallback hop; release it rather than risk advancing on stale state.
    await release(args, initialRecord, kv);
    return;
  }

  const last = attempts.at(-1);
  if (!last || last.status === 'failed') {
    await release(args, initialRecord, kv);
    return;
  }

  await rearmTimer(
    args.env,
    args.options.timer,
    args.id,
    args.options.fallbackTimeoutMs ??
      chainTimeoutMs(initialRecord.kind, args.options.delivery?.timeout),
    payload
  );
}
