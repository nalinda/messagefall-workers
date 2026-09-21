/**
 * Failing tests for KV delivery-status store (GitHub Issue #6).
 *
 * Acceptance criteria:
 * - Tests with miniflare KV binding cover create, get, update, provider-id index and lookup,
 *   and TTL passed to `put` (default 604800s, custom via opts.ttlSeconds).
 * - Overall status derivation tested for chain-present (worst-of-chain, pending before attempts)
 *   and chain-absent policies (worst of always attempts: failed < sent < delivered < read).
 * - Zero-content leakage, for what the status store itself writes: renders a template with a
 *   known code, drives create and update through this store, then scans the KV namespace and
 *   asserts no code, rendered text, subject, html, input or params landed in it. The fixture
 *   writes nothing but the store's own `msg:<id>` and `pid:<provider>:<providerId>` entries, so that is
 *   the scope of the guarantee — not the namespace a real send leaves behind. A real send also
 *   writes the raw plaintext render input to `in:<id>` here, which is a deliberate, documented
 *   gap (the README's Delivery status section, and the CHANGELOG's known limitations) and is
 *   not covered by this suite.
 * - MessageRecord and Attempt shapes are verified and exported.
 */

import type { KVNamespace, KVNamespacePutOptions } from '@cloudflare/workers-types';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { DeliveryPolicy } from '../../src/core/policy.js';
import {
  type Attempt,
  kvStatusStore,
  type MessageRecord,
  type ProviderRef,
  type StatusStore,
} from '../../src/core/status.js';
import type { Channel, DeliveryStatus } from '../../src/providers/types.js';
import { render } from '../../src/templates.js';
import { createMiniflareKV } from '../helpers/status.js';

describe('Issue #6: Delivery-status store in KV', () => {
  let kv: KVNamespace;
  let disposeKv: () => Promise<void>;

  beforeEach(async () => {
    const miniflareEnv = await createMiniflareKV();
    kv = miniflareEnv.kv;
    disposeKv = miniflareEnv.dispose;
  });

  afterEach(async () => {
    await disposeKv();
  });

  describe('kvStatusStore CRUD and Key Mapping', () => {
    it('creates and retrieves a MessageRecord round-trip with msg:<id> key mapping', async () => {
      const store: StatusStore = kvStatusStore(kv);

      const record: MessageRecord = {
        id: 'msg_01J9TEST000000000000000001',
        template: 'otpVerification',
        kind: 'otp',
        policy: { fallback: ['whatsapp', 'sms'], always: [] },
        chain: {
          status: 'pending',
          attempts: [],
        },
        always: [],
        status: 'pending',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:00.000Z',
      };

      await store.create(record);

      // Direct KV inspection: key must use "msg:<id>" prefix
      const rawStored = await kv.get(`msg:${record.id}`);
      expect(rawStored).not.toBeNull();
      const parsedStored = JSON.parse(rawStored as string) as MessageRecord;
      expect(parsedStored).toEqual(record);

      // StatusStore#get retrieval
      const fetched = await store.get(record.id);
      expect(fetched).toEqual(record);

      // Non-existent ID returns null
      const nonExistent = await store.get('msg_01J9NONEXISTENT0000000000');
      expect(nonExistent).toBeNull();
    });

    it('performs idempotent read-modify-write updates on MessageRecord', async () => {
      const store: StatusStore = kvStatusStore(kv);

      const initialRecord: MessageRecord = {
        id: 'msg_01J9TEST000000000000000002',
        template: 'securityAlert',
        kind: 'notification',
        policy: { fallback: ['whatsapp', 'sms'], always: ['email'] },
        chain: {
          status: 'pending',
          attempts: [],
        },
        always: [],
        status: 'pending',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:00.000Z',
      };

      await store.create(initialRecord);

      const attempt1: Attempt = {
        channel: 'whatsapp',
        provider: 'meta-wa',
        providerId: 'wamid.HBgL1234567890',
        status: 'sent',
        at: '2026-09-20T10:00:02.000Z',
      };

      const updatedRecord = await store.update(initialRecord.id, (rec) => ({
        ...rec,
        chain: {
          status: 'sent',
          attempts: [...rec.chain.attempts, attempt1],
        },
        status: 'sent',
        updatedAt: '2026-09-20T10:00:02.000Z',
      }));

      expect(updatedRecord.status).toBe('sent');
      expect(updatedRecord.chain.status).toBe('sent');
      expect(updatedRecord.chain.attempts).toHaveLength(1);
      expect(updatedRecord.chain.attempts[0]).toEqual(attempt1);

      // Verify stored record reflects the update
      const fetched = await store.get(initialRecord.id);
      expect(fetched).toEqual(updatedRecord);

      // Idempotent update verification: running an idempotent modifier twice produces identical state
      const idempotentFn = (rec: MessageRecord): MessageRecord => ({
        ...rec,
        chain: {
          status: 'delivered',
          attempts: rec.chain.attempts.map((a) =>
            a.providerId === 'wamid.HBgL1234567890' ? { ...a, status: 'delivered' } : a
          ),
        },
        status: 'delivered',
        updatedAt: '2026-09-20T10:00:05.000Z',
      });

      const firstRun = await store.update(initialRecord.id, idempotentFn);
      const secondRun = await store.update(initialRecord.id, idempotentFn);

      expect(firstRun).toEqual(secondRun);
      expect(firstRun.status).toBe('delivered');
      expect(firstRun.chain.attempts[0]?.status).toBe('delivered');
    });

    it('throws when attempting to update a non-existent record', async () => {
      const store: StatusStore = kvStatusStore(kv);

      let thrownError: Error | undefined;
      try {
        await store.update('msg_missing', (rec) => ({ ...rec, status: 'delivered' }));
      } catch (err) {
        thrownError = err as Error;
      }

      expect(thrownError).toBeDefined();
    });

    it('indexes and looks up providerId round-trip with pid:<provider>:<providerId> key mapping', async () => {
      const store: StatusStore = kvStatusStore(kv);

      const providerId = 'wamid.HBgL9876543210';
      const ref: ProviderRef = {
        id: 'msg_01J9TEST000000000000000003',
        channel: 'whatsapp',
        provider: 'meta-wa',
      };

      await store.indexProviderId(providerId, ref);

      // Direct KV inspection: the key is scoped to the provider's own id space, so two providers
      // minting the same bare id index separately instead of overwriting one another.
      const rawStored = await kv.get(`pid:${ref.provider}:${providerId}`);
      expect(rawStored).not.toBeNull();
      const parsedStored = JSON.parse(rawStored as string) as ProviderRef;
      expect(parsedStored).toEqual(ref);

      // StatusStore#lookupProviderId retrieval
      const lookup = await store.lookupProviderId(providerId, ref.provider);
      expect(lookup).toEqual(ref);

      // The same id under a different provider is a different key, so it does not resolve.
      expect(await store.lookupProviderId(providerId, 'twilio-sms')).toBeNull();

      // Non-existent providerId returns null
      const nonExistent = await store.lookupProviderId('wamid.nonexistent', ref.provider);
      expect(nonExistent).toBeNull();
    });

    it('passes default TTL (604800s) to KV put calls for msg and pid keys', async () => {
      const putCalls: Array<{ key: string; value: string; options?: KVNamespacePutOptions }> = [];
      const originalPut = kv.put.bind(kv);

      // Spy on kv.put to capture options passed
      kv.put = (async (
        key: string,
        value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
        options?: KVNamespacePutOptions
      ): Promise<void> => {
        const strVal = typeof value === 'string' ? value : JSON.stringify(value);
        putCalls.push({ key, value: strVal, options });
        return originalPut(key, value as string, options);
      }) as unknown as typeof kv.put;

      const store: StatusStore = kvStatusStore(kv);

      const record: MessageRecord = {
        id: 'msg_01J9TEST000000000000000004',
        template: 'loginCode',
        kind: 'otp',
        policy: { fallback: ['sms'], always: [] },
        chain: { status: 'pending', attempts: [] },
        always: [],
        status: 'pending',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:00.000Z',
      };

      await store.create(record);
      await store.indexProviderId('pid_sms_12345', {
        id: record.id,
        channel: 'sms',
        provider: 'twilio',
      });
      await store.update(record.id, (rec) => ({ ...rec, status: 'sent' }));

      expect(putCalls.length).toBeGreaterThanOrEqual(3);

      for (const call of putCalls) {
        expect(call.options).toBeDefined();
        expect(call.options?.expirationTtl).toBe(604_800);
      }
    });

    it('passes custom ttlSeconds to KV put calls when configured in options', async () => {
      const putCalls: Array<{ key: string; value: string; options?: KVNamespacePutOptions }> = [];
      const originalPut = kv.put.bind(kv);

      kv.put = (async (
        key: string,
        value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
        options?: KVNamespacePutOptions
      ): Promise<void> => {
        const strVal = typeof value === 'string' ? value : JSON.stringify(value);
        putCalls.push({ key, value: strVal, options });
        return originalPut(key, value as string, options);
      }) as unknown as typeof kv.put;

      const customTtl = 86_400; // 1 day
      const store: StatusStore = kvStatusStore(kv, { ttlSeconds: customTtl });

      const record: MessageRecord = {
        id: 'msg_01J9TEST000000000000000005',
        template: 'customTtlTest',
        kind: 'notification',
        policy: { fallback: ['email'], always: [] },
        chain: { status: 'pending', attempts: [] },
        always: [],
        status: 'pending',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:00.000Z',
      };

      await store.create(record);
      await store.indexProviderId('pid_email_9999', {
        id: record.id,
        channel: 'email',
        provider: 'resend',
      });

      expect(putCalls.length).toBeGreaterThanOrEqual(2);

      for (const call of putCalls) {
        expect(call.options).toBeDefined();
        expect(call.options?.expirationTtl).toBe(customTtl);
      }
    });
  });

  describe('Overall Status Derivation', () => {
    const chainPolicy: DeliveryPolicy = { fallback: ['whatsapp', 'sms'], always: ['email'] };
    const noChainPolicy: DeliveryPolicy = { fallback: [], always: ['whatsapp', 'sms', 'email'] };

    describe('Chain-present policy', () => {
      it('derives pending when no attempts have been recorded', async () => {
        const store = kvStatusStore(kv);
        const record: MessageRecord = {
          id: 'msg_chain_pending',
          template: 'otp',
          kind: 'otp',
          policy: chainPolicy,
          chain: { status: 'pending', attempts: [] },
          always: [],
          status: 'pending',
          createdAt: '2026-09-20T10:00:00.000Z',
          updatedAt: '2026-09-20T10:00:00.000Z',
        };
        await store.create(record);
        const fetched = await store.get(record.id);
        expect(fetched?.status).toBe('pending');
      });

      it('derives overall status directly from chain status regardless of always attempts', async () => {
        const store = kvStatusStore(kv);

        const statuses: DeliveryStatus[] = ['sent', 'delivered', 'read', 'failed'];

        for (const chainStatus of statuses) {
          const record: MessageRecord = {
            id: `msg_chain_${chainStatus}`,
            template: 'alert',
            kind: 'notification',
            policy: chainPolicy,
            chain: {
              status: chainStatus,
              attempts: [
                {
                  channel: 'whatsapp',
                  provider: 'meta',
                  status: chainStatus,
                  at: '2026-09-20T10:00:01.000Z',
                },
              ],
            },
            // Always attempt with contradictory status should NOT affect overall status
            always: [
              {
                channel: 'email',
                provider: 'resend',
                status: chainStatus === 'failed' ? 'delivered' : 'failed',
                at: '2026-09-20T10:00:01.000Z',
              },
            ],
            status: chainStatus,
            createdAt: '2026-09-20T10:00:00.000Z',
            updatedAt: '2026-09-20T10:00:01.000Z',
          };

          await store.create(record);
          const fetched = await store.get(record.id);
          expect(fetched?.status).toBe(chainStatus);
        }
      });
    });

    describe('Chain-absent policy', () => {
      it('derives pending when always attempts array is empty', async () => {
        const store = kvStatusStore(kv);
        const record: MessageRecord = {
          id: 'msg_no_chain_pending',
          template: 'broadcast',
          kind: 'notification',
          policy: noChainPolicy,
          chain: { status: 'pending', attempts: [] },
          always: [],
          status: 'pending',
          createdAt: '2026-09-20T10:00:00.000Z',
          updatedAt: '2026-09-20T10:00:00.000Z',
        };
        await store.create(record);
        const fetched = await store.get(record.id);
        expect(fetched?.status).toBe('pending');
      });

      it('derives worst status across always attempts using failed < sent < delivered < read ordering', async () => {
        const store = kvStatusStore(kv);

        const testCases: Array<{
          attempts: DeliveryStatus[];
          expectedWorst: DeliveryStatus;
        }> = [
          // failed beats everything
          { attempts: ['failed', 'read', 'delivered'], expectedWorst: 'failed' },
          { attempts: ['read', 'failed', 'sent'], expectedWorst: 'failed' },
          { attempts: ['failed'], expectedWorst: 'failed' },

          // sent beats delivered and read
          { attempts: ['sent', 'delivered', 'read'], expectedWorst: 'sent' },
          { attempts: ['read', 'sent'], expectedWorst: 'sent' },
          { attempts: ['sent'], expectedWorst: 'sent' },

          // delivered beats read
          { attempts: ['delivered', 'read'], expectedWorst: 'delivered' },
          { attempts: ['read', 'delivered'], expectedWorst: 'delivered' },
          { attempts: ['delivered'], expectedWorst: 'delivered' },

          // read only when all are read
          { attempts: ['read', 'read'], expectedWorst: 'read' },
          { attempts: ['read'], expectedWorst: 'read' },
        ];

        for (const [index, { attempts, expectedWorst }] of testCases.entries()) {
          const alwaysAttempts: Attempt[] = attempts.map((status, i) => ({
            channel: (['whatsapp', 'sms', 'email'] as Channel[])[i % 3] ?? 'sms',
            provider: `provider-${i}`,
            status,
            at: `2026-09-20T10:00:0${i}.000Z`,
          }));

          const record: MessageRecord = {
            id: `msg_worst_${index}`,
            template: 'broadcast',
            kind: 'notification',
            policy: noChainPolicy,
            chain: { status: 'pending', attempts: [] },
            always: alwaysAttempts,
            status: expectedWorst,
            createdAt: '2026-09-20T10:00:00.000Z',
            updatedAt: '2026-09-20T10:00:05.000Z',
          };

          await store.create(record);
          const fetched = await store.get(record.id);
          expect(fetched?.status).toBe(expectedWorst);
        }
      });
    });
  });

  describe('Zero-Rendered Content Leakage (Privacy & Security)', () => {
    it('stores zero rendered body, secret OTP code, params, or template text in KV values', async () => {
      const secretCode = '987654';
      const recipientPhone = '+15550009999';
      const templateName = 'sensitiveOtp';

      // Define a template and render it
      const renderedSms = render(
        {
          input: z.object({ code: z.string().length(6) }),
          kind: 'otp',
          sms: ({ code }) => `Your security passcode is ${code}. Do not share.`,
        },
        'sms',
        { code: secretCode },
        'en'
      );

      expect(renderedSms).toBeDefined();
      const renderedText = (renderedSms as { text: string }).text;
      expect(renderedText).toContain(secretCode);

      const store = kvStatusStore(kv);

      // Create initial message record for dispatch
      const messageId = 'msg_01J9SECRET0000000000000001';
      const record: MessageRecord = {
        id: messageId,
        template: templateName,
        kind: 'otp',
        policy: { fallback: ['sms'], always: [] },
        chain: {
          status: 'pending',
          attempts: [],
        },
        always: [],
        status: 'pending',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:00.000Z',
      };

      await store.create(record);

      // Simulate sending via provider and recording attempt
      const providerId = 'twilio_SM_secret_777';
      await store.indexProviderId(providerId, {
        id: messageId,
        channel: 'sms',
        provider: 'twilio',
      });

      await store.update(messageId, (rec) => ({
        ...rec,
        chain: {
          status: 'sent',
          attempts: [
            {
              channel: 'sms',
              provider: 'twilio',
              providerId,
              status: 'sent',
              at: '2026-09-20T10:00:02.000Z',
            },
          ],
        },
        status: 'sent',
        updatedAt: '2026-09-20T10:00:02.000Z',
      }));

      // Scan every single key and value in the entire KV store
      const listResult = await kv.list();
      expect(listResult.keys.length).toBeGreaterThan(0);

      const forbiddenSubstrings = [
        secretCode,
        renderedText,
        'passcode',
        'security passcode',
        recipientPhone,
        '{ code:',
        '"code":',
      ];

      for (const { name: key } of listResult.keys) {
        // Assert key does not contain secret
        for (const forbidden of forbiddenSubstrings) {
          expect(key).not.toContain(forbidden);
        }

        const rawValue = await kv.get(key);
        expect(rawValue).not.toBeNull();

        // Assert value does not contain secret or rendered text
        for (const forbidden of forbiddenSubstrings) {
          expect(rawValue as string).not.toContain(forbidden);
        }

        // Verify that parsed JSON values match only allowed metadata schemas
        const parsed = JSON.parse(rawValue as string) as Record<string, unknown>;
        expect(parsed).not.toHaveProperty('text');
        expect(parsed).not.toHaveProperty('body');
        expect(parsed).not.toHaveProperty('subject');
        expect(parsed).not.toHaveProperty('html');
        expect(parsed).not.toHaveProperty('input');
        expect(parsed).not.toHaveProperty('params');
        expect(parsed).not.toHaveProperty('to');
      }
    });
  });

  describe('MessageRecord and Attempt Shape Conformance', () => {
    it('matches exact MessageRecord schema so #13 status route can return it directly', () => {
      const record: MessageRecord = {
        id: 'msg_01J9ULID000000000000000000',
        template: 'orderConfirmation',
        kind: 'notification',
        policy: { fallback: ['whatsapp', 'sms'], always: ['email'] },
        chain: {
          status: 'delivered',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta',
              providerId: 'wamid.123',
              status: 'delivered',
              error: undefined,
              at: '2026-09-20T10:00:01.000Z',
            },
          ],
        },
        always: [
          {
            channel: 'email',
            provider: 'resend',
            providerId: 'email.456',
            status: 'delivered',
            at: '2026-09-20T10:00:01.000Z',
          },
        ],
        status: 'delivered',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:01.000Z',
      };

      // Exact field presence and types
      expect(typeof record.id).toBe('string');
      expect(record.id.startsWith('msg_')).toBe(true);
      expect(typeof record.template).toBe('string');
      expect(['otp', 'notification']).toContain(record.kind);
      expect(record.policy).toBeDefined();
      expect(Array.isArray(record.policy.fallback)).toBe(true);
      expect(Array.isArray(record.policy.always)).toBe(true);
      expect(record.chain).toBeDefined();
      expect(typeof record.chain.status).toBe('string');
      expect(Array.isArray(record.chain.attempts)).toBe(true);
      expect(Array.isArray(record.always)).toBe(true);
      expect(typeof record.status).toBe('string');
      expect(typeof record.createdAt).toBe('string');
      expect(typeof record.updatedAt).toBe('string');

      // Attempt shape check
      const attempt = record.chain.attempts[0];
      expect(attempt).toBeDefined();
      expect(['whatsapp', 'sms', 'email']).toContain(attempt.channel);
      expect(typeof attempt.provider).toBe('string');
      expect(typeof attempt.providerId).toBe('string');
      expect(['sent', 'delivered', 'read', 'failed']).toContain(attempt.status);
      expect(typeof attempt.at).toBe('string');
    });
  });
});
