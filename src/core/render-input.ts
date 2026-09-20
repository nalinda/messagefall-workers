/**
 * The render input side-store: the `in:<id>` KV key and the payload it carries.
 *
 * A `MessageRecord` deliberately holds no message content, but the asynchronous fallback path
 * has to re-render the message on the next channel, so the send pipeline stashes the render
 * inputs separately — under `in:<id>` in KV with a TTL matching the chain timeout, and with the
 * fallback timer's state. This module owns that key and its payload type so the writer
 * (`./send.js`), the readers (`./fallback.js`, `./webhook.js`) and the cleanup paths all agree
 * on one shape instead of hand-mirroring it. It also owns the other end of that lifetime:
 * {@link releaseChain}, the single terminal-state cleanup every path calls once a chain can no
 * longer advance.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import type { FallbackTimerClient } from './status.js';

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
 * treated as the bare template input. Unreadable or absent entries yield `undefined`: the
 * fallback path degrades to rendering from an empty input rather than failing.
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
 * Called from every path that settles a chain for good — the synchronous send exhausting its
 * fallback channels, the asynchronous advance exhausting or accepting them, and a `delivered` /
 * `read` webhook arriving. Both steps are best-effort: the chain is already terminal, so a
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
  if (isTimedChain(fallback)) {
    try {
      await timer?.cancel?.(id);
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
