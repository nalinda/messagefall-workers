/**
 * Test helpers and type definitions for KV delivery-status store specifications (Issue #6).
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

import type { DeliveryPolicy } from '../../src/core/policy.js';
import type { Channel, DeliveryStatus } from '../../src/providers/types.js';
import { patchMiniflareProxy } from './miniflare-proxy.js';

/**
 * Single delivery attempt on a channel.
 */
export interface Attempt {
  channel: Channel;
  provider: string;
  providerId?: string;
  status: DeliveryStatus;
  error?: string;
  at: string;
}

/**
 * Message record stored in KV status store.
 */
export interface MessageRecord {
  id: string;
  template: string;
  kind: 'otp' | 'notification';
  policy: DeliveryPolicy;
  chain: { status: DeliveryStatus | 'pending'; attempts: Attempt[] };
  always: Attempt[];
  status: DeliveryStatus | 'pending';
  createdAt: string;
  updatedAt: string;
}

/**
 * Provider ID reference mapping.
 */
export interface ProviderRef {
  id: string;
  channel: Channel;
  provider: string;
}

/**
 * Status store options.
 */
export interface StatusStoreOptions {
  ttlSeconds?: number;
}

/**
 * KV status store interface.
 */
export interface StatusStore {
  create(record: MessageRecord): Promise<void>;
  get(id: string): Promise<MessageRecord | null>;
  update(id: string, fn: (r: MessageRecord) => MessageRecord): Promise<MessageRecord>;
  indexProviderId(providerId: string, ref: ProviderRef): Promise<void>;
  lookupProviderId(providerId: string): Promise<ProviderRef | null>;
}

/**
 * Status module API interface.
 */
export interface StatusApi {
  kvStatusStore: (kv: KVNamespace, opts?: StatusStoreOptions) => StatusStore;
  deriveOverallStatus?: (
    policy: DeliveryPolicy,
    chain: { status: DeliveryStatus | 'pending'; attempts?: Attempt[] },
    always: Attempt[]
  ) => DeliveryStatus | 'pending';
}

/**
 * Creates an isolated Miniflare instance with a test KV namespace.
 *
 * @returns Object containing the KV binding and a dispose callback.
 */
export async function createMiniflareKV(): Promise<{
  kv: KVNamespace;
  dispose: () => Promise<void>;
}> {
  patchMiniflareProxy();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("OK"); } }',
      kvNamespaces: ['STATUS_KV'],
      compatibilityDate: '2024-01-01',
    })
  );

  const bindings = await mf.getBindings<{ STATUS_KV: KVNamespace }>();
  return {
    kv: bindings.STATUS_KV,
    dispose: async () => {
      await mf.dispose();
    },
  };
}

/**
 * Loads the status module from src/core/status.js if implemented, or falls back to
 * dummy stubs so tests execute real assertions and fail for the right reason.
 */
export async function loadStatusApi(): Promise<StatusApi> {
  try {
    const statusEntry = '../../src/core/status.js';
    const mod = (await import(statusEntry)) as unknown as Partial<StatusApi>;
    if (mod.kvStatusStore) {
      return mod as StatusApi;
    }
  } catch {
    // status.js not yet implemented
  }

  const root = (await import('../../src/index.js')) as unknown as Partial<StatusApi>;
  if (root.kvStatusStore) {
    return root as StatusApi;
  }

  return {
    kvStatusStore: (_kv: KVNamespace, _opts?: StatusStoreOptions): StatusStore => {
      return {
        create: () => Promise.resolve(),
        get: () => Promise.resolve(null),
        update: (_id, fn) => {
          const dummyRecord: MessageRecord = {
            id: _id,
            template: '',
            kind: 'notification',
            policy: { fallback: [], always: [] },
            chain: { status: 'pending', attempts: [] },
            always: [],
            status: 'pending',
            createdAt: '',
            updatedAt: '',
          };
          fn(dummyRecord);
          return Promise.resolve(dummyRecord);
        },
        indexProviderId: () => Promise.resolve(),
        lookupProviderId: () => Promise.resolve(null),
      };
    },
    deriveOverallStatus: () => 'pending',
  };
}
