/**
 * Delivery-status store in KV for tracking message lifecycle across isolates.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import type { Channel, DeliveryStatus } from '../providers/types.js';
import type { DeliveryPolicy } from './policy.js';

interface PatchableProxy {
  __mfPatched?: boolean;
}

function wrapHandler(handler: ProxyHandler<Record<string | symbol, unknown>>): void {
  if (typeof handler.get !== 'function') {
    return;
  }
  const origGet = handler.get.bind(handler);
  handler.get = (target, key, receiver) => {
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      return target[key as string];
    }
    return origGet(target, key, receiver) as unknown;
  };
}

function patchMiniflareProxy(): void {
  const OriginalProxy = Proxy;
  const patchable = OriginalProxy as unknown as PatchableProxy;
  if (patchable.__mfPatched) {
    return;
  }

  const PatchedProxy = new OriginalProxy(OriginalProxy, {
    construct(target, constructorArgs, newTarget) {
      const [, handler] = constructorArgs as [
        Record<string | symbol, unknown>,
        ProxyHandler<Record<string | symbol, unknown>>,
      ];
      wrapHandler(handler);
      return Reflect.construct(target, constructorArgs, newTarget) as object;
    },
  });

  (PatchedProxy as unknown as PatchableProxy).__mfPatched = true;
  // eslint-disable-next-line unicorn/no-global-object-property-assignment
  (globalThis as unknown as { Proxy: unknown }).Proxy = PatchedProxy;
}

// eslint-disable-next-line unicorn/no-top-level-side-effects
patchMiniflareProxy();

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
  kind: 'otp' | 'notification';
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
   * @param providerId - External provider ID.
   * @param ref - Reference object containing internal message ID, channel, and provider.
   */
  indexProviderId(providerId: string, ref: ProviderRef): Promise<void>;

  /**
   * Looks up the provider reference associated with a provider ID.
   *
   * @param providerId - External provider ID.
   * @returns The reference if found, or null.
   */
  lookupProviderId(providerId: string): Promise<ProviderRef | null>;
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
 * - `pid:<providerId>` - ProviderRef serialized as JSON.
 *
 * @param kv - Cloudflare KV namespace instance.
 * @param opts - Status store options (e.g. custom TTL).
 * @returns An implementation of {@link StatusStore}.
 */
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
      await kv.put(`pid:${providerId}`, JSON.stringify(ref), {
        expirationTtl: ttl,
      });
    },

    async lookupProviderId(providerId: string): Promise<ProviderRef | null> {
      const data = await kv.get(`pid:${providerId}`);
      if (data === null) {
        return null;
      }
      return JSON.parse(data) as ProviderRef;
    },
  };
}
