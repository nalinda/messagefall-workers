/**
 * Per-message serialization for the fallback advance path.
 *
 * Advancing a chain is read-decide-send: `advanceChain` reads the record, decides the last
 * attempt is `failed` and dispatches the next channel. Nothing in that sequence is atomic, so two
 * deliveries of the same `failed` webhook — vendors redeliver routinely — can both read the same
 * record, both pass `shouldSkipAdvancement` and both walk the chain, putting two attempts (two
 * real sends) on the next channel. For an OTP that is the same one-time code sent twice.
 *
 * {@link withAdvanceLock} closes that in two layers, because neither one is sufficient alone:
 *
 * - **In-isolate**, advances for one message id are chained onto a single promise, so the second
 *   one waits and then re-reads the record — by which point the first has recorded its attempt
 *   and `shouldSkipAdvancement` no-ops it. This layer is exact: it is ordinary single-threaded
 *   JavaScript, not a heuristic.
 * - **Across isolates**, a short lease in KV (`lock:<id>`) is taken before advancing and dropped
 *   afterwards; an advance that finds a live lease is skipped. KV has no compare-and-set and its
 *   writes are not instantly visible everywhere, so this narrows the window rather than closing
 *   it: two genuinely simultaneous deliveries landing in different colos can still both acquire.
 *   Closing it completely needs a per-message Durable Object on the advance path (the
 *   `FallbackTimer` is per-message but optional), which 0.1.0 does not require.
 *
 * The lease carries its own expiry in its value rather than relying on the KV entry's TTL, whose
 * minimum is 60 seconds: an isolate evicted mid-advance would otherwise block every advance for
 * that message for a full minute, silently turning fallback off for it.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import { createLogger } from './logger.js';

const logger = createLogger();

/**
 * How long a lease is honoured. Long enough to cover an advance (a render, one provider call and
 * a couple of KV writes), short enough that a lease abandoned by an evicted isolate costs at most
 * this much fallback latency.
 */
const LEASE_MS = 10_000;

/**
 * KV's minimum `expirationTtl`, in seconds. The lease's real lifetime is {@link LEASE_MS}; this
 * only stops an abandoned key from living out the store's default TTL.
 */
const LEASE_KV_TTL_SECONDS = 60;

/**
 * The KV key a message's advance lease is held under.
 */
function leaseKey(id: string): string {
  return `lock:${id}`;
}

/**
 * Advances in flight in this isolate, keyed on message id.
 */
const inFlight = new Map<string, Promise<void>>();

/**
 * Takes the cross-isolate lease, or reports that someone else holds it. A KV fault resolves in
 * favour of advancing: the lease is an optimisation, and losing fallback outright is the worse
 * failure of the two.
 */
async function didAcquireLease(kv: KVNamespace, id: string): Promise<boolean> {
  try {
    const held = await kv.get(leaseKey(id));
    if (held !== null && Number(held) > Date.now()) {
      return false;
    }
    await kv.put(leaseKey(id), String(Date.now() + LEASE_MS), {
      expirationTtl: LEASE_KV_TTL_SECONDS,
    });
    return true;
  } catch {
    return true;
  }
}

async function releaseLease(kv: KVNamespace, id: string): Promise<void> {
  try {
    await kv.delete(leaseKey(id));
  } catch {
    // Best effort: the lease expires on its own.
  }
}

/**
 * Runs one chain advance for `id` with no other advance for the same message running alongside
 * it. See the module comment for what that guarantees and what it does not.
 *
 * @param kv - The KV namespace the cross-isolate lease lives in.
 * @param id - Internal message identifier.
 * @param run - The advance to serialize.
 */
export async function withAdvanceLock(
  kv: KVNamespace,
  id: string,
  run: () => Promise<void>
): Promise<void> {
  const previous = inFlight.get(id);
  const next = (async (): Promise<void> => {
    if (previous) {
      try {
        await previous;
      } catch {
        // Already surfaced to whoever started that advance.
      }
    }
    if (!(await didAcquireLease(kv, id))) {
      logger.warn('fallback.advance-skipped', { id });
      return;
    }
    try {
      await run();
    } finally {
      await releaseLease(kv, id);
    }
  })();

  inFlight.set(id, next);
  try {
    await next;
  } finally {
    if (inFlight.get(id) === next) {
      inFlight.delete(id);
    }
  }
}
