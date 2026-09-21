/**
 * The render input side-store: the `in:<id>` KV key and the payload it carries.
 *
 * A `MessageRecord` deliberately holds no message content, but the asynchronous fallback path
 * has to re-render the message on the next channel, so the send pipeline stashes the render
 * inputs separately — under `in:<id>` in KV with a TTL matching the chain timeout, and with the
 * fallback timer's state. This module owns that key and its payload type so the writer
 * (`./send.js`), the readers (`./fallback.js`, `./webhook.js`) and the cleanup paths all agree
 * on one shape instead of hand-mirroring it. It also owns the other end of that lifetime:
 * {@link sealAndReleaseChain}, the single terminal-state cleanup every path calls once a chain
 * can no longer advance — marking the record `sealed` and then running {@link releaseChain}, its
 * teardown half.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import { createLogger } from './logger.js';
import type { StatusStore } from './status.js';
import type { FallbackTimerClient } from './timer.js';

const logger = createLogger();

/**
 * Everything the fallback path needs to re-render a message on the next channel.
 *
 * Written on send under {@link renderInputKey} and handed to the fallback timer, so any
 * change here changes both the KV payload and the timer's stashed state.
 */
export interface RenderInput {
  /**
   * Raw (unvalidated) template input, as the caller passed it to `send`.
   */
  input: unknown;
  /**
   * Recipient phone number in E.164 form.
   */
  to?: string;
  /**
   * Recipient email address, when the send had one.
   */
  email?: string;
  /**
   * Locale the message was rendered in.
   */
  locale?: string;
}

/**
 * Locale used when a render input carries none.
 */
export const DEFAULT_LOCALE = 'en';

/**
 * The KV key the render input for a message is stored under.
 *
 * @param id - Internal message identifier.
 * @returns The `in:<id>` key.
 */
export function renderInputKey(id: string): string {
  return `in:${id}`;
}

/**
 * Reads the render input for a message back out of KV.
 *
 * A payload that is not the {@link RenderInput} envelope (an older or hand-written entry) is
 * treated as the bare template input. Unreadable or absent entries yield `undefined`, and the
 * fallback path then records the next channel as a failed attempt rather than dispatching a
 * message rebuilt from nothing — which would reach a real gateway with a blank recipient.
 *
 * @param kv - KV namespace holding the key, if the deployment has one.
 * @param id - Internal message identifier.
 * @returns The stored render input, or undefined when there is none to read.
 */
export async function readRenderInput(
  kv: KVNamespace | undefined,
  id: string
): Promise<RenderInput | undefined> {
  if (!kv || typeof kv.get !== 'function') {
    return undefined;
  }
  const raw = await kv.get(renderInputKey(id));
  if (!raw) {
    return undefined;
  }
  try {
    return asRenderInput(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * The {@link RenderInput} fields of `source`, and nothing else: `input` always, `to` / `email` /
 * `locale` only when defined. The one place the shape is copied, so the timer's stored state,
 * its arm arguments and the fallback path's merges all build on it instead of restating it.
 *
 * @param source - Anything carrying the render input fields (an arm argument, a stored timer,
 * a KV payload).
 * @returns A fresh render input without undefined keys.
 */
export function pickRenderInput(source: RenderInput): RenderInput {
  return {
    input: source.input,
    ...(source.to !== undefined && { to: source.to }),
    ...(source.email !== undefined && { email: source.email }),
    ...(source.locale !== undefined && { locale: source.locale }),
  };
}

/**
 * Coerces an opaque value into a {@link RenderInput}: an envelope is taken as-is, anything else
 * is treated as the bare template input.
 *
 * @param value - The value recovered from KV, the timer, or a caller pass-through.
 * @returns The value as a render input.
 */
export function asRenderInput(value: unknown): RenderInput {
  if (value && typeof value === 'object' && 'input' in value) {
    return value;
  }
  return { input: value };
}

/**
 * Whether a chain of `fallback` channels ever arms the fallback timer: only when there is a
 * channel left to move on to after the first. The send path arms on this condition and the
 * release paths cancel on it, so a single-channel chain or policy `'all'` never costs a Durable
 * Object round-trip in either direction.
 *
 * @param fallback - The resolved policy's chain.
 * @returns True when the timer is armed for such a chain.
 */
export function isTimedChain(fallback: readonly unknown[]): boolean {
  return fallback.length > 1;
}

/**
 * Terminal-state cleanup for one message: disarm the fallback timer and drop its render input.
 *
 * The teardown half of {@link sealAndReleaseChain}, which is how every path that settles a chain
 * for good reaches it — the synchronous send exhausting its fallback channels, the asynchronous
 * advance exhausting or accepting them, and a `delivered` / `read` webhook arriving. Both steps
 * are best-effort: the chain is already terminal, so a
 * timer that cannot be reached or a KV delete that fails must not turn into a caller-visible
 * error. The KV entry carries a TTL, so a missed delete expires on its own; a missed cancel
 * costs one timer fire that `advanceChain` then finds nothing to do for.
 *
 * The timer is only cancelled for a chain that {@link isTimedChain}; for any other policy the
 * cancel would instantiate a Durable Object just to delete nothing.
 *
 * @param timer - The resolved fallback timer, if the deployment has one.
 * @param kv - The KV namespace holding the render input, if the deployment has one.
 * @param id - Internal message identifier.
 * @param fallback - The record's resolved chain, deciding whether a timer was ever armed.
 */
export async function releaseChain(
  timer: FallbackTimerClient | undefined,
  kv: KVNamespace | undefined,
  id: string,
  fallback: readonly unknown[]
): Promise<void> {
  if (isTimedChain(fallback) && typeof timer?.cancel === 'function') {
    try {
      await timer.cancel(id);
      logger.info('timer.cancelled', { id });
    } catch {
      // Best-effort cancellation
    }
  }
  try {
    await kv?.delete(renderInputKey(id));
  } catch {
    // Best-effort deletion
  }
}

/**
 * The whole terminal-state cleanup: mark the record `sealed`, then {@link releaseChain}.
 *
 * Every path that ends a chain for good goes through here, so the flag and the teardown cannot
 * drift apart. They have to travel together because the cancel in `releaseChain` is deliberately
 * best-effort: a lost cancel means the alarm still fires later, and only `sealed` stops
 * `shouldSkipAdvancement` letting that fire through to a second terminal `onStatus` event for a
 * chain nothing has actually changed about.
 *
 * Sealing is best effort in its own right. The chain's terminal outcome is recorded and notified
 * by the time this runs, so a KV fault — or a record that has since expired — must not turn a
 * finished send or advance into a thrown one. The worst case of a lost write is the behaviour
 * that existed before the flag.
 *
 * @param store - The status store holding the record to seal.
 * @param timer - The resolved fallback timer, if the deployment has one.
 * @param kv - The KV namespace holding the render input, if the deployment has one.
 * @param id - Internal message identifier.
 * @param fallback - The record's resolved chain, deciding whether a timer was ever armed.
 */
export async function sealAndReleaseChain(
  store: Pick<StatusStore, 'update'>,
  timer: FallbackTimerClient | undefined,
  kv: KVNamespace | undefined,
  id: string,
  fallback: readonly unknown[]
): Promise<void> {
  try {
    await store.update(id, (current) => ({ ...current, sealed: true }));
  } catch {
    // Best-effort sealing
  }
  await releaseChain(timer, kv, id, fallback);
}
