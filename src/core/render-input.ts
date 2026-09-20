/**
 * The render input side-store: the `in:<id>` KV key and the payload it carries.
 *
 * A `MessageRecord` deliberately holds no message content, but the asynchronous fallback path
 * has to re-render the message on the next channel, so the send pipeline stashes the render
 * inputs separately — under `in:<id>` in KV with a TTL matching the chain timeout, and with the
 * fallback timer's state. This module owns that key and its payload type so the writer
 * (`./send.js`), the readers (`./fallback.js`, `./webhook.js`) and the cleanup paths all agree
 * on one shape instead of hand-mirroring it.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

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
