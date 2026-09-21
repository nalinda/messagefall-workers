/**
 * Delivery-status store in KV for tracking message lifecycle across isolates.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import type { Channel, DeliveryStatus, TemplateKind } from '../providers/types.js';
import type { DeliveryPolicy } from './policy.js';

/**
 * Single delivery attempt on a channel.
 */
export interface Attempt {
  /**
   * Channel attempted.
   */
  channel: Channel;
  /**
   * Provider name handling this attempt.
   */
  provider: string;
  /**
   * Provider-assigned message/task identifier.
   */
  providerId?: string;
  /**
   * Delivery status of this attempt.
   */
  status: DeliveryStatus;
  /**
   * Error message if attempt failed.
   */
  error?: string;
  /**
   * ISO 8601 timestamp when attempt occurred.
   */
  at: string;
}

/**
 * Complete message record stored in KV status store.
 */
export interface MessageRecord {
  /**
   * Unique message identifier (e.g. msg_ + ULID).
   */
  id: string;
  /**
   * Template identifier.
   */
  template: string;
  /**
   * Template classification.
   */
  kind: TemplateKind;
  /**
   * Resolved delivery policy for this send.
   */
  policy: DeliveryPolicy;
  /**
   * Primary fallback chain state and attempts.
   */
  chain: {
    status: DeliveryStatus | 'pending';
    attempts: Attempt[];
  };
  /**
   * Parallel always-on delivery attempts (at most one per channel).
   */
  always: Attempt[];
  /**
   * Overall derived delivery status.
   */
  status: DeliveryStatus | 'pending';
  /**
   * Whether this chain's fallback processing is finished for good: every channel it was going to
   * try has been tried, the terminal outcome has been recorded and notified, and the timer and
   * stored render input have been released. Set once, by the fallback path's own release step.
   *
   * Deliberately separate from `chain.status`, which cannot answer the same question: a chain's
   * status legitimately reads `'failed'` on the very first advance too (the failing attempt is
   * written to the record before the advance it triggers is even invoked), so status alone
   * cannot tell "just finalized on this call" from "already finalized on a previous one". This
   * flag can, which is what makes `advanceChain` idempotent when called directly.
   */
  sealed?: boolean;
  /**
   * ISO 8601 creation timestamp.
   */
  createdAt: string;
  /**
   * ISO 8601 last-updated timestamp.
   */
  updatedAt: string;
}

/**
 * Reference mapping a provider-specific ID back to a message.
 */
export interface ProviderRef {
  /**
   * Internal message ID.
   */
  id: string;
  /**
   * Channel of the provider.
   */
  channel: Channel;
  /**
   * Provider name.
   */
  provider: string;
}

/**
 * Options for configuring the KV status store.
 */
export interface StatusStoreOptions {
  /**
   * TTL in seconds for KV records (default: 604800s / 7 days).
   */
  ttlSeconds?: number;
}

/**
 * Interface for reading, modifying, and indexing delivery status in KV.
 */
export interface StatusStore {
  /**
   * Persists an initial MessageRecord to KV.
   *
   * @param record - Message record to store.
   */
  create(record: MessageRecord): Promise<void>;

  /**
   * Retrieves a MessageRecord by internal message ID.
   *
   * @param id - Internal message identifier.
   * @returns The record if found, or null.
   */
  get(id: string): Promise<MessageRecord | null>;

  /**
   * Atomically reads, modifies, and writes back a MessageRecord.
   *
   * Note: KV provides last-writer-wins semantics without transactional guarantees.
   * Mutators should remain idempotent.
   *
   * @param id - Internal message identifier.
   * @param fn - Transformation function applied to existing record.
   * @returns The updated MessageRecord.
   * @throws {MessageRecordNotFoundError} If the record does not exist.
   */
  update(id: string, fn: (r: MessageRecord) => MessageRecord): Promise<MessageRecord>;

  /**
   * Indexes a provider ID mapping back to the message.
   *
   * The index is scoped by the provider the id came from (`ref.provider`): a provider id is only
   * unique within its own vendor, and several attempts on one message can legitimately carry the
   * same bare id — the console provider mints `console_<messageId>` on every channel, and two
   * real vendors can collide by coincidence. An index keyed on the bare id alone is
   * last-writer-wins across all of a message's attempts, so a webhook from one provider would
   * resolve to another provider's attempt.
   *
   * @param providerId - External provider ID.
   * @param ref - Reference object containing internal message ID, channel, and provider.
   */
  indexProviderId(providerId: string, ref: ProviderRef): Promise<void>;

  /**
   * Looks up the provider reference associated with a provider ID, within one provider's own
   * id space. See {@link StatusStore.indexProviderId} for why the provider is part of the key.
   *
   * @param providerId - External provider ID.
   * @param provider - Name of the provider the id belongs to (the webhook route's provider).
   * @returns The reference if found, or null.
   */
  lookupProviderId(providerId: string, provider: string): Promise<ProviderRef | null>;
}

/**
 * Thrown by `StatusStore.update` when no record exists for the id. Not transient: callers
 * should not retry it.
 */
export class MessageRecordNotFoundError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`MessageRecord not found: ${id}`);
    this.name = 'MessageRecordNotFoundError';
    this.id = id;
  }
}

/**
 * Default status record TTL: 7 days in seconds.
 */
export const DEFAULT_STATUS_TTL = 604_800;

/**
 * Whether a chain status is terminal: nothing further can happen to the chain, so the fallback
 * timer is cancelled (or, when it fires anyway, only cleans up). `sent` and `pending` are not.
 *
 * @param status - The chain's status.
 * @returns True for `delivered`, `read` and `failed`.
 */
export function isTerminalChainStatus(status: DeliveryStatus | 'pending'): boolean {
  return TERMINAL_CHAIN_STATUSES.has(status);
}

const TERMINAL_CHAIN_STATUSES: ReadonlySet<DeliveryStatus | 'pending'> = new Set([
  'delivered',
  'read',
  'failed',
]);

/**
 * Whether a status is a confirmed delivery: the message demonstrably reached the recipient.
 *
 * Narrower than {@link isTerminalChainStatus}, and the distinction matters — a `failed` chain is
 * terminal but has NOT been delivered, so it may still advance onto its next channel, while a
 * `delivered` / `read` one must never be sent again. Every caller that decides "may this still
 * fall back?" (`shouldSkipAdvancement`, the webhook bridge's pre-check) reads it from here, so
 * those decisions cannot drift apart from one another.
 *
 * @param status - An attempt's or the chain's status.
 * @returns True for `delivered` and `read`.
 */
export function isConfirmedDelivery(
  status: DeliveryStatus | 'pending'
): status is 'delivered' | 'read' {
  return status === 'delivered' || status === 'read';
}

function getStatusPrecedence(status: DeliveryStatus): number {
  switch (status) {
    case 'failed': {
      return 0;
    }
    case 'sent': {
      return 1;
    }
    case 'delivered': {
      return 2;
    }
    case 'read': {
      return 3;
    }
  }
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
 * The best confirmation any attempt on the chain carries: the highest-precedence attempt status
 * by {@link getStatusPrecedence} — the one ordering of these statuses — and then only when that
 * is a confirmed delivery. Anything below `delivered` is no confirmation at all.
 */
function confirmedDelivery(attempts: Attempt[]): 'delivered' | 'read' | undefined {
  let best: Attempt['status'] | undefined;
  for (const attempt of attempts) {
    if (best === undefined || getStatusPrecedence(attempt.status) > getStatusPrecedence(best)) {
      best = attempt.status;
    }
  }
  return best !== undefined && isConfirmedDelivery(best) ? best : undefined;
}

/**
 * The chain's status right now, from the attempts on the record plus, when known, the walk's
 * actual progress (attempts whose write was lost still count as attempted). A `failed` tail is
 * terminal only once every configured fallback channel has been attempted; until then the chain
 * is `pending`, because the next channel has yet to be tried.
 *
 * A `delivered` / `read` on ANY attempt — not just the last — is the chain's answer. The chain
 * exists to get one message to one recipient, so the moment any channel confirms delivery the
 * chain has succeeded, whatever a later or superseded attempt says. This matters because an
 * earlier attempt can be confirmed *after* the walk has moved on: a chain can fail over from
 * WhatsApp to SMS and only then receive WhatsApp's `delivered` callback, which `isStatusProgression`
 * accepts as a genuine late upgrade. Reading only the last attempt would report that chain as
 * `sent` (or, once SMS also fails, `failed`) even though the message demonstrably arrived — the
 * wrong terminal outcome for a caller polling `GET /status/:id`, and the wrong input to the
 * fallback walk's own "is this chain still live?" decision.
 *
 * The corollary is that such a chain is terminal, and so is released (timer cancelled, render
 * input dropped) even while a later attempt is still `sent`: a delivered chain must never fall
 * back again, which is exactly what `shouldSkipAdvancement` already enforces for
 * `delivered` / `read`. Nothing is released while the chain could still legitimately advance,
 * because a `failed` tail with channels left to try derives `pending`, not a terminal status.
 *
 * This is THE answer to "what is this chain's status"; do not derive it a second way. Both
 * writers use it: the send pipeline's `attemptRecorder` after each synchronous attempt, and the
 * webhook path's `applyStatusUpdate` after a delivery status arrives. Taking the latest
 * attempt's raw status instead would write a terminal `failed` for, say, a `{ fallback:
 * ['whatsapp', 'sms'] }` chain the moment WhatsApp failed — before SMS was tried — which a
 * client polling `/status` reads as a false final failure, and which the fallback timer's
 * terminal check reads as licence to clean up a chain that is still live.
 *
 * @param attempts - The chain attempts as they stand on the record.
 * @param fallback - The chain's configured fallback channels, in order.
 * @param progress - The walk's progress, when the caller knows it.
 * @returns The chain status.
 */
export function chainStatus(
  attempts: Attempt[],
  fallback: Channel[],
  progress?: ChainProgress
): MessageRecord['chain']['status'] {
  if (fallback.length === 0) {
    return 'pending';
  }
  const confirmed = confirmedDelivery(attempts);
  if (confirmed !== undefined) {
    return confirmed;
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
 * Derives overall delivery status from policy, chain state, and always attempts.
 *
 * Rules:
 * - When policy has a fallback chain, status equals chain status.
 * - When policy has no fallback chain (chain-absent):
 *   - 'pending' if no always attempts have been recorded.
 *   - Worst of always attempts using ordering: failed < sent < delivered < read.
 *
 * @param policy - Effective delivery policy.
 * @param chain - Chain state containing status and attempts.
 * @param always - Always-on delivery attempts.
 * @returns Overall derived status.
 */
export function deriveOverallStatus(
  policy: DeliveryPolicy,
  chain: { status: DeliveryStatus | 'pending'; attempts?: Attempt[] },
  always: Attempt[]
): DeliveryStatus | 'pending' {
  if (policy.fallback.length > 0) {
    return chain.status;
  }

  if (always.length === 0) {
    return 'pending';
  }

  let worst: DeliveryStatus = always[0].status;
  for (const attempt of always) {
    if (getStatusPrecedence(attempt.status) < getStatusPrecedence(worst)) {
      worst = attempt.status;
    }
  }

  return worst;
}

/**
 * Creates a KV-backed delivery status store.
 *
 * Keys:
 * - `msg:<id>` - MessageRecord serialized as JSON.
 * - `pid:<provider>:<providerId>` - ProviderRef serialized as JSON, scoped to the provider whose
 *   id space the providerId belongs to.
 *
 * @param kv - Cloudflare KV namespace instance.
 * @param opts - Status store options (e.g. custom TTL).
 * @returns An implementation of {@link StatusStore}.
 */
/**
 * The KV key one provider's id maps under. The provider name is the prefix, so the id itself may
 * contain anything (including `:`) without ambiguity — the key is never parsed back apart.
 */
function providerIdKey(provider: string, providerId: string): string {
  return `pid:${provider}:${providerId}`;
}

export function kvStatusStore(kv: KVNamespace, opts?: StatusStoreOptions): StatusStore {
  const ttl = opts?.ttlSeconds ?? DEFAULT_STATUS_TTL;

  async function getRecord(id: string): Promise<MessageRecord | null> {
    const data = await kv.get(`msg:${id}`);
    if (data === null) {
      return null;
    }
    return JSON.parse(data) as MessageRecord;
  }

  return {
    async create(record: MessageRecord): Promise<void> {
      await kv.put(`msg:${record.id}`, JSON.stringify(record), {
        expirationTtl: ttl,
      });
    },

    get: getRecord,

    async update(id: string, fn: (r: MessageRecord) => MessageRecord): Promise<MessageRecord> {
      const existing = await getRecord(id);
      if (!existing) {
        throw new MessageRecordNotFoundError(id);
      }
      const updated = fn(existing);
      await kv.put(`msg:${id}`, JSON.stringify(updated), {
        expirationTtl: ttl,
      });
      return updated;
    },

    async indexProviderId(providerId: string, ref: ProviderRef): Promise<void> {
      await kv.put(providerIdKey(ref.provider, providerId), JSON.stringify(ref), {
        expirationTtl: ttl,
      });
    },

    async lookupProviderId(providerId: string, provider: string): Promise<ProviderRef | null> {
      const data = await kv.get(providerIdKey(provider, providerId));
      if (data === null) {
        return null;
      }
      return JSON.parse(data) as ProviderRef;
    },
  };
}
