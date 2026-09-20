/**
 * Failing tests for Fallback on failed delivery status (GitHub Issue #7).
 *
 * Acceptance criteria:
 * - A `failed` status on the WhatsApp chain attempt produces an SMS attempt rendered
 *   from the SMS template, and the record shows both attempts in order.
 * - A subsequent `failed` SMS status ends with `chain.status = 'failed'` and the SMS error
 *   as the final error.
 * - A `failed` email status on an `always` attempt changes only that attempt.
 * - Calling `advanceChain` twice for the same failure produces one extra attempt, not two.
 * - `in:<id>` is written on send with the correct TTL and deleted on a terminal chain state.
 * - `advanceChain` called via `reason: 'timeout'` behaves the same as `'failed'` for channel advancement.
 * - Immediate send failure during fallback recurses to next channel until exhausted.
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { advanceChain, type AdvanceChainArgs } from '../../src/core/fallback.js';
import type { DeliveryPolicy } from '../../src/core/policy.js';
import {
  kvStatusStore,
  type MessageRecord,
  type StatusStore,
} from '../../src/core/status.js';
import type {
  Channel,
  OutboundMeta,
  Provider,
  RenderedEmail,
  RenderedSms,
  RenderedWhatsApp,
  SendResult,
} from '../../src/providers/types.js';
import { defineTemplates } from '../../src/templates.js';
import {
  createMockFallbackTimer,
  type MockFallbackTimer,
} from '../helpers/fallback.js';
import { createMiniflareKV } from '../helpers/status.js';

interface SentCall<T = unknown> {
  message: T & OutboundMeta;
  at: Date;
}

function createRecordingProvider(
  name: string,
  channel: Channel,
  sendImpl?: (meta: OutboundMeta & Record<string, unknown>) => Promise<SendResult>
): Provider & { calls: SentCall[] } {
  const calls: SentCall[] = [];
  let seq = 0;
  return {
    name,
    channel,
    calls,
    send: async (message: OutboundMeta & Record<string, unknown>): Promise<SendResult> => {
      calls.push({ message, at: new Date() });
      if (sendImpl) {
        return sendImpl(message);
      }
      seq++;
      return {
        ok: true,
        providerId: `${name}_${Date.now()}_${seq}`,
      };
    },
  };
}

const testTemplates = defineTemplates({
  otpVerification: {
    kind: 'otp',
    whatsapp: {
      template: 'auth_otp_code',
      language: 'en',
      params: (input: { code: string }) => [input.code],
    },
    sms: (input: { code: string }) => `Your authentication code is ${input.code}. Valid for 5m.`,
    email: {
      subject: () => 'Your verification code',
      text: (input: { code: string }) => `Your security code is ${input.code}`,
    },
  },
  alertNotification: {
    kind: 'notification',
    whatsapp: {
      text: (input: { text: string }) => `[ALERT] ${input.text}`,
    },
    sms: (input: { text: string }) => `ALERT: ${input.text}`,
    email: {
      subject: () => 'System Alert',
      text: (input: { text: string }) => `System Notification: ${input.text}`,
    },
  },
});

describe('Issue #7: Fallback on failed delivery status', () => {
  let kv: KVNamespace;
  let disposeKv: () => Promise<void>;
  let store: StatusStore;
  let mockTimer: MockFallbackTimer;

  beforeEach(async () => {
    const miniflareEnv = await createMiniflareKV();
    kv = miniflareEnv.kv;
    disposeKv = miniflareEnv.dispose;
    store = kvStatusStore(kv);
    mockTimer = createMockFallbackTimer();
  });

  afterEach(async () => {
    await disposeKv();
  });

  describe('WhatsApp failure advances to SMS (primary fallback progression)', () => {
    it('produces an SMS attempt rendered from the SMS template, and the record shows both attempts in order', async () => {
      const waProvider = createRecordingProvider('meta-wa', 'whatsapp');
      const smsProvider = createRecordingProvider('twilio-sms', 'sms');

      const messageId = 'msg_01J9FB00000000000000000001';
      const initialRecord: MessageRecord = {
        id: messageId,
        template: 'otpVerification',
        kind: 'otp',
        policy: { fallback: ['whatsapp', 'sms'], always: [] },
        chain: {
          status: 'failed',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId: 'wa_msg_101',
              status: 'failed',
              error: 'Recipient WhatsApp account not found',
              at: '2026-09-20T10:00:00.000Z',
            },
          ],
        },
        always: [],
        status: 'failed',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:05.000Z',
      };
      await store.create(initialRecord);

      // Input stored in KV as in:<id>
      await kv.put(
        `in:${messageId}`,
        JSON.stringify({
          input: { code: '739104' },
          to: '+94771234567',
          locale: 'en',
        })
      );

      const onStatusEvents: unknown[] = [];
      const args: AdvanceChainArgs = {
        id: messageId,
        reason: 'failed',
        env: { MESSAGES_KV: kv },
        options: {
          timer: mockTimer,
          templates: testTemplates,
          providers: [waProvider, smsProvider],
          onStatus: (event) => {
            onStatusEvents.push(event);
          },
          fallbackTimeoutMs: 10_000,
        },
        store,
      };

      await advanceChain(args);

      // Assertion: SMS provider was called with rendered SMS template content
      expect(smsProvider.calls).toHaveLength(1);
      const smsCall = smsProvider.calls[0].message as RenderedSms & OutboundMeta;
      expect(smsCall.to).toBe('+94771234567');
      expect(smsCall.text).toBe('Your authentication code is 739104. Valid for 5m.');
      expect(smsCall.messageId).toBe(messageId);
      expect(smsCall.template).toBe('otpVerification');

      // Assertion: Record contains both attempts in chronological order
      const updatedRecord = await store.get(messageId);
      expect(updatedRecord).not.toBeNull();
      expect(updatedRecord?.chain.attempts).toHaveLength(2);

      const [attempt1, attempt2] = updatedRecord!.chain.attempts;
      expect(attempt1.channel).toBe('whatsapp');
      expect(attempt1.provider).toBe('meta-wa');
      expect(attempt1.status).toBe('failed');
      expect(attempt1.error).toBe('Recipient WhatsApp account not found');

      expect(attempt2.channel).toBe('sms');
      expect(attempt2.provider).toBe('twilio-sms');
      expect(attempt2.status).toBe('sent');
      expect(attempt2.providerId).toBeDefined();

      // Assertion: Chain status is updated to 'sent' (pending delivery)
      expect(updatedRecord?.chain.status).toBe('sent');
      expect(updatedRecord?.status).toBe('sent');

      // Assertion: onStatus was called
      expect(onStatusEvents.length).toBeGreaterThan(0);
    });

    it('indexes the newly created SMS provider id in the status store', async () => {
      const smsProvider = createRecordingProvider('mock-sms', 'sms', () =>
        Promise.resolve({
          ok: true,
          providerId: 'sms_vendor_ref_999',
        })
      );
      const waProvider = createRecordingProvider('mock-wa', 'whatsapp');

      const messageId = 'msg_01J9FB00000000000000000002';
      const initialRecord: MessageRecord = {
        id: messageId,
        template: 'otpVerification',
        kind: 'otp',
        policy: { fallback: ['whatsapp', 'sms'], always: [] },
        chain: {
          status: 'failed',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'mock-wa',
              providerId: 'wa_vendor_ref_888',
              status: 'failed',
              error: 'Delivery rejected by carrier',
              at: '2026-09-20T10:00:00.000Z',
            },
          ],
        },
        always: [],
        status: 'failed',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:02.000Z',
      };
      await store.create(initialRecord);

      await kv.put(
        `in:${messageId}`,
        JSON.stringify({
          input: { code: '554433' },
          to: '+15559876543',
          locale: 'en',
        })
      );

      await advanceChain({
        id: messageId,
        reason: 'failed',
        env: { MESSAGES_KV: kv },
        options: {
          templates: testTemplates,
          providers: [waProvider, smsProvider],
        },
        store,
      });

      const providerRef = await store.lookupProviderId('sms_vendor_ref_999');
      expect(providerRef).not.toBeNull();
      expect(providerRef?.id).toBe(messageId);
      expect(providerRef?.channel).toBe('sms');
      expect(providerRef?.provider).toBe('mock-sms');
    });

    it('re-arms fallback timer when timer binding is present in env', async () => {
      const waProvider = createRecordingProvider('meta-wa', 'whatsapp');
      const smsProvider = createRecordingProvider('twilio-sms', 'sms');

      const messageId = 'msg_01J9FB00000000000000000003';
      const initialRecord: MessageRecord = {
        id: messageId,
        template: 'otpVerification',
        kind: 'otp',
        policy: { fallback: ['whatsapp', 'sms'], always: [] },
        chain: {
          status: 'failed',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId: 'wa_103',
              status: 'failed',
              error: 'No WhatsApp user found',
              at: '2026-09-20T10:00:00.000Z',
            },
          ],
        },
        always: [],
        status: 'failed',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:05.000Z',
      };
      await store.create(initialRecord);

      await kv.put(
        `in:${messageId}`,
        JSON.stringify({
          input: { code: '112233' },
          to: '+94770000003',
          locale: 'en',
        })
      );

      await advanceChain({
        id: messageId,
        reason: 'failed',
        env: { MESSAGES_KV: kv },
        options: {
          timer: mockTimer,
          templates: testTemplates,
          providers: [waProvider, smsProvider],
          fallbackTimeoutMs: 15_000,
        },
        store,
      });

      expect(mockTimer.rearmed.length).toBeGreaterThan(0);
      const lastRearmed = mockTimer.rearmed.at(-1);
      expect(lastRearmed?.messageId).toBe(messageId);
      expect(lastRearmed?.timeoutMs).toBe(15_000);
    });
  });

  describe('Exhausting fallback chain ends with failed chain status', () => {
    it('a subsequent failed SMS status ends with chain.status = "failed" and the SMS error as the final error', async () => {
      const waProvider = createRecordingProvider('meta-wa', 'whatsapp');
      const smsProvider = createRecordingProvider('twilio-sms', 'sms');

      const messageId = 'msg_01J9FB00000000000000000004';
      const initialRecord: MessageRecord = {
        id: messageId,
        template: 'otpVerification',
        kind: 'otp',
        policy: { fallback: ['whatsapp', 'sms'], always: [] },
        chain: {
          status: 'sent',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId: 'wa_104',
              status: 'failed',
              error: 'WhatsApp network error',
              at: '2026-09-20T10:00:00.000Z',
            },
            {
              channel: 'sms',
              provider: 'twilio-sms',
              providerId: 'sms_104',
              status: 'failed',
              error: 'SMS carrier destination unreachable (Error 30008)',
              at: '2026-09-20T10:00:10.000Z',
            },
          ],
        },
        always: [],
        status: 'sent',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:10.000Z',
      };
      await store.create(initialRecord);

      await kv.put(
        `in:${messageId}`,
        JSON.stringify({
          input: { code: '998877' },
          to: '+94770000004',
          locale: 'en',
        })
      );

      const statusEvents: unknown[] = [];
      await advanceChain({
        id: messageId,
        reason: 'failed',
        env: { MESSAGES_KV: kv },
        options: {
          timer: mockTimer,
          templates: testTemplates,
          providers: [waProvider, smsProvider],
          onStatus: (event) => {
            statusEvents.push(event);
          },
        },
        store,
      });

      const updatedRecord = await store.get(messageId);
      expect(updatedRecord).not.toBeNull();
      // No further channels remain in policy.fallback: ['whatsapp', 'sms']
      expect(updatedRecord?.chain.status).toBe('failed');
      expect(updatedRecord?.status).toBe('failed');

      // The last attempt's error is preserved as the final error
      const lastAttempt = updatedRecord?.chain.attempts.at(-1);
      expect(lastAttempt?.channel).toBe('sms');
      expect(lastAttempt?.error).toBe('SMS carrier destination unreachable (Error 30008)');

      // No new attempts were made
      expect(updatedRecord?.chain.attempts).toHaveLength(2);
      expect(smsProvider.calls).toHaveLength(0);

      // onStatus was notified
      expect(statusEvents.length).toBeGreaterThan(0);
    });

    it('cancels the fallback timer when chain reaches terminal failed state', async () => {
      const messageId = 'msg_01J9FB00000000000000000005';
      const record: MessageRecord = {
        id: messageId,
        template: 'otpVerification',
        kind: 'otp',
        policy: { fallback: ['whatsapp', 'sms'], always: [] },
        chain: {
          status: 'sent',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              status: 'failed',
              error: 'wa error',
              at: '2026-09-20T10:00:00.000Z',
            },
            {
              channel: 'sms',
              provider: 'twilio-sms',
              status: 'failed',
              error: 'sms error',
              at: '2026-09-20T10:00:05.000Z',
            },
          ],
        },
        always: [],
        status: 'sent',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:05.000Z',
      };
      await store.create(record);
      mockTimer.setState(messageId, 10_000);

      await advanceChain({
        id: messageId,
        reason: 'failed',
        env: { MESSAGES_KV: kv },
        options: {
          timer: mockTimer,
          templates: testTemplates,
          providers: [],
        },
        store,
      });

      expect(mockTimer.isCancelled(messageId)).toBe(true);
    });

    it('deletes in:<id> from KV when chain reaches terminal failed state', async () => {
      const messageId = 'msg_01J9FB00000000000000000006';
      const record: MessageRecord = {
        id: messageId,
        template: 'otpVerification',
        kind: 'otp',
        policy: { fallback: ['whatsapp'], always: [] },
        chain: {
          status: 'sent',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              status: 'failed',
              error: 'WhatsApp failed',
              at: '2026-09-20T10:00:00.000Z',
            },
          ],
        },
        always: [],
        status: 'sent',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:00.000Z',
      };
      await store.create(record);

      await kv.put(`in:${messageId}`, JSON.stringify({ input: { code: '1234' } }));
      expect(await kv.get(`in:${messageId}`)).not.toBeNull();

      await advanceChain({
        id: messageId,
        reason: 'failed',
        env: { MESSAGES_KV: kv },
        options: {
          templates: testTemplates,
          providers: [],
        },
        store,
      });

      // Chain exhausted -> terminal state -> in:<id> deleted
      const kvEntry = await kv.get(`in:${messageId}`);
      expect(kvEntry).toBeNull();
    });
  });

  describe('Always attempts independence', () => {
    it('a failed email status on an always attempt changes only that attempt and never touches the chain', async () => {
      const waProvider = createRecordingProvider('meta-wa', 'whatsapp');
      const smsProvider = createRecordingProvider('twilio-sms', 'sms');
      const emailProvider = createRecordingProvider('postmark', 'email');

      const messageId = 'msg_01J9FB00000000000000000007';
      const record: MessageRecord = {
        id: messageId,
        template: 'alertNotification',
        kind: 'notification',
        policy: { fallback: ['whatsapp', 'sms'], always: ['email'] },
        chain: {
          status: 'sent',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId: 'wa_107',
              status: 'sent',
              at: '2026-09-20T10:00:00.000Z',
            },
          ],
        },
        always: [
          {
            channel: 'email',
            provider: 'postmark',
            providerId: 'email_107',
            status: 'failed',
            error: 'SMTP 550 Mailbox does not exist',
            at: '2026-09-20T10:00:02.000Z',
          },
        ],
        status: 'sent',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:02.000Z',
      };
      await store.create(record);

      await kv.put(
        `in:${messageId}`,
        JSON.stringify({
          input: { text: 'Server overload' },
          to: '+94770000007',
          locale: 'en',
        })
      );

      // Even if advanceChain was called, it inspects chain.attempts (which is 'sent', not 'failed')
      await advanceChain({
        id: messageId,
        reason: 'failed',
        env: { MESSAGES_KV: kv },
        options: {
          templates: testTemplates,
          providers: [waProvider, smsProvider, emailProvider],
        },
        store,
      });

      const updatedRecord = await store.get(messageId);
      expect(updatedRecord).not.toBeNull();

      // Chain attempts remain only WhatsApp in 'sent' status
      expect(updatedRecord?.chain.attempts).toHaveLength(1);
      expect(updatedRecord?.chain.attempts[0].channel).toBe('whatsapp');
      expect(updatedRecord?.chain.attempts[0].status).toBe('sent');

      // SMS provider was NOT called
      expect(smsProvider.calls).toHaveLength(0);

      // Always attempt remains only email with 'failed' status
      expect(updatedRecord?.always).toHaveLength(1);
      expect(updatedRecord?.always[0].channel).toBe('email');
      expect(updatedRecord?.always[0].status).toBe('failed');
      expect(updatedRecord?.always[0].error).toBe('SMTP 550 Mailbox does not exist');
    });

    it('advancing fallback chain does not modify or re-dispatch always attempts', async () => {
      const waProvider = createRecordingProvider('meta-wa', 'whatsapp');
      const smsProvider = createRecordingProvider('twilio-sms', 'sms');
      const emailProvider = createRecordingProvider('postmark', 'email');

      const messageId = 'msg_01J9FB00000000000000000008';
      const record: MessageRecord = {
        id: messageId,
        template: 'alertNotification',
        kind: 'notification',
        policy: { fallback: ['whatsapp', 'sms'], always: ['email'] },
        chain: {
          status: 'failed',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId: 'wa_108',
              status: 'failed',
              error: 'WhatsApp unroutable',
              at: '2026-09-20T10:00:00.000Z',
            },
          ],
        },
        always: [
          {
            channel: 'email',
            provider: 'postmark',
            providerId: 'email_108',
            status: 'sent',
            at: '2026-09-20T10:00:00.000Z',
          },
        ],
        status: 'failed',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:05.000Z',
      };
      await store.create(record);

      await kv.put(
        `in:${messageId}`,
        JSON.stringify({
          input: { text: 'Disk almost full' },
          to: '+94770000008',
          locale: 'en',
        })
      );

      await advanceChain({
        id: messageId,
        reason: 'failed',
        env: { MESSAGES_KV: kv },
        options: {
          templates: testTemplates,
          providers: [waProvider, smsProvider, emailProvider],
        },
        store,
      });

      // SMS was dispatched for fallback chain
      expect(smsProvider.calls).toHaveLength(1);
      // Email was NOT re-dispatched
      expect(emailProvider.calls).toHaveLength(0);

      const updatedRecord = await store.get(messageId);
      expect(updatedRecord?.chain.attempts).toHaveLength(2);
      expect(updatedRecord?.always).toHaveLength(1);
      expect(updatedRecord?.always[0].providerId).toBe('email_108');
    });
  });

  describe('Idempotency and Terminal State Protection', () => {
    it('calling advanceChain twice for the same failure produces one extra attempt, not two', async () => {
      const waProvider = createRecordingProvider('meta-wa', 'whatsapp');
      const smsProvider = createRecordingProvider('twilio-sms', 'sms');

      const messageId = 'msg_01J9FB00000000000000000009';
      const record: MessageRecord = {
        id: messageId,
        template: 'otpVerification',
        kind: 'otp',
        policy: { fallback: ['whatsapp', 'sms'], always: [] },
        chain: {
          status: 'failed',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId: 'wa_109',
              status: 'failed',
              error: 'WhatsApp timeout',
              at: '2026-09-20T10:00:00.000Z',
            },
          ],
        },
        always: [],
        status: 'failed',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:05.000Z',
      };
      await store.create(record);

      await kv.put(
        `in:${messageId}`,
        JSON.stringify({
          input: { code: '654321' },
          to: '+94770000009',
          locale: 'en',
        })
      );

      const args: AdvanceChainArgs = {
        id: messageId,
        reason: 'failed',
        env: { MESSAGES_KV: kv },
        options: {
          templates: testTemplates,
          providers: [waProvider, smsProvider],
        },
        store,
      };

      // First call -> advances from WhatsApp to SMS
      await advanceChain(args);
      expect(smsProvider.calls).toHaveLength(1);

      // Second call (e.g. repeated webhook or duplicate timer fire)
      await advanceChain(args);

      // SMS should NOT be dispatched a second time
      expect(smsProvider.calls).toHaveLength(1);

      const updatedRecord = await store.get(messageId);
      expect(updatedRecord?.chain.attempts).toHaveLength(2);
    });

    it('does nothing when chain.status is already delivered', async () => {
      const smsProvider = createRecordingProvider('twilio-sms', 'sms');

      const messageId = 'msg_01J9FB00000000000000000010';
      const record: MessageRecord = {
        id: messageId,
        template: 'otpVerification',
        kind: 'otp',
        policy: { fallback: ['whatsapp', 'sms'], always: [] },
        chain: {
          status: 'delivered',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId: 'wa_110',
              status: 'delivered',
              at: '2026-09-20T10:00:05.000Z',
            },
          ],
        },
        always: [],
        status: 'delivered',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:05.000Z',
      };
      await store.create(record);

      await advanceChain({
        id: messageId,
        reason: 'failed',
        env: { MESSAGES_KV: kv },
        options: {
          templates: testTemplates,
          providers: [smsProvider],
        },
        store,
      });

      expect(smsProvider.calls).toHaveLength(0);
      const unchanged = await store.get(messageId);
      expect(unchanged?.chain.status).toBe('delivered');
      expect(unchanged?.chain.attempts).toHaveLength(1);
    });

    it('does nothing when chain.status is already read', async () => {
      const smsProvider = createRecordingProvider('twilio-sms', 'sms');

      const messageId = 'msg_01J9FB00000000000000000011';
      const record: MessageRecord = {
        id: messageId,
        template: 'otpVerification',
        kind: 'otp',
        policy: { fallback: ['whatsapp', 'sms'], always: [] },
        chain: {
          status: 'read',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId: 'wa_111',
              status: 'read',
              at: '2026-09-20T10:00:05.000Z',
            },
          ],
        },
        always: [],
        status: 'read',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:05.000Z',
      };
      await store.create(record);

      await advanceChain({
        id: messageId,
        reason: 'failed',
        env: { MESSAGES_KV: kv },
        options: {
          templates: testTemplates,
          providers: [smsProvider],
        },
        store,
      });

      expect(smsProvider.calls).toHaveLength(0);
      const unchanged = await store.get(messageId);
      expect(unchanged?.chain.status).toBe('read');
      expect(unchanged?.chain.attempts).toHaveLength(1);
    });

    it('does nothing when chain.status is already failed and terminal', async () => {
      const smsProvider = createRecordingProvider('twilio-sms', 'sms');

      const messageId = 'msg_01J9FB00000000000000000012';
      const record: MessageRecord = {
        id: messageId,
        template: 'otpVerification',
        kind: 'otp',
        policy: { fallback: ['whatsapp', 'sms'], always: [] },
        chain: {
          status: 'failed',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              status: 'failed',
              error: 'WA fail',
              at: '2026-09-20T10:00:00.000Z',
            },
            {
              channel: 'sms',
              provider: 'twilio-sms',
              status: 'failed',
              error: 'SMS fail',
              at: '2026-09-20T10:00:05.000Z',
            },
          ],
        },
        always: [],
        status: 'failed',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:05.000Z',
      };
      await store.create(record);

      await advanceChain({
        id: messageId,
        reason: 'failed',
        env: { MESSAGES_KV: kv },
        options: {
          templates: testTemplates,
          providers: [smsProvider],
        },
        store,
      });

      expect(smsProvider.calls).toHaveLength(0);
      const unchanged = await store.get(messageId);
      expect(unchanged?.chain.attempts).toHaveLength(2);
    });
  });

  describe('Fallback advancement via timeout reason', () => {
    it('advances from WhatsApp to SMS when advanceChain is called with reason: "timeout"', async () => {
      const waProvider = createRecordingProvider('meta-wa', 'whatsapp');
      const smsProvider = createRecordingProvider('twilio-sms', 'sms');

      const messageId = 'msg_01J9FB00000000000000000013';
      const record: MessageRecord = {
        id: messageId,
        template: 'otpVerification',
        kind: 'otp',
        policy: { fallback: ['whatsapp', 'sms'], always: [] },
        chain: {
          status: 'sent',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId: 'wa_113',
              status: 'sent',
              at: '2026-09-20T10:00:00.000Z',
            },
          ],
        },
        always: [],
        status: 'sent',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:00.000Z',
      };
      await store.create(record);

      await kv.put(
        `in:${messageId}`,
        JSON.stringify({
          input: { code: '409281' },
          to: '+94770000013',
          locale: 'en',
        })
      );

      // Fallback timer fires with reason: 'timeout'
      await advanceChain({
        id: messageId,
        reason: 'timeout',
        env: { MESSAGES_KV: kv },
        options: {
          templates: testTemplates,
          providers: [waProvider, smsProvider],
        },
        store,
      });

      // SMS provider was called with rendered SMS template
      expect(smsProvider.calls).toHaveLength(1);
      const smsCall = smsProvider.calls[0].message as RenderedSms & OutboundMeta;
      expect(smsCall.text).toBe('Your authentication code is 409281. Valid for 5m.');

      const updatedRecord = await store.get(messageId);
      expect(updatedRecord?.chain.attempts).toHaveLength(2);
      expect(updatedRecord?.chain.attempts[0].channel).toBe('whatsapp');
      expect(updatedRecord?.chain.attempts[1].channel).toBe('sms');
      expect(updatedRecord?.chain.status).toBe('sent');
    });
  });

  describe('Immediate provider send failure and recursion', () => {
    it('recurses to next channel when immediate send fails on the next fallback provider', async () => {
      const waProvider = createRecordingProvider('meta-wa', 'whatsapp');
      // SMS provider fails immediately on send
      const smsProvider = createRecordingProvider('twilio-sms', 'sms', () =>
        Promise.resolve({
          ok: false,
          error: 'Twilio SMS service unavailable (503)',
        })
      );
      // Email provider succeeds
      const emailProvider = createRecordingProvider('postmark', 'email', () =>
        Promise.resolve({
          ok: true,
          providerId: 'email_ok_114',
        })
      );

      const messageId = 'msg_01J9FB00000000000000000014';
      const record: MessageRecord = {
        id: messageId,
        template: 'otpVerification',
        kind: 'otp',
        policy: { fallback: ['whatsapp', 'sms', 'email'], always: [] },
        chain: {
          status: 'failed',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId: 'wa_114',
              status: 'failed',
              error: 'WhatsApp phone not registered',
              at: '2026-09-20T10:00:00.000Z',
            },
          ],
        },
        always: [],
        status: 'failed',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:05.000Z',
      };
      await store.create(record);

      await kv.put(
        `in:${messageId}`,
        JSON.stringify({
          input: { code: '887766' },
          to: '+94770000014',
          locale: 'en',
        })
      );

      await advanceChain({
        id: messageId,
        reason: 'failed',
        env: { MESSAGES_KV: kv },
        options: {
          templates: testTemplates,
          providers: [waProvider, smsProvider, emailProvider],
        },
        store,
      });

      // Both SMS and Email were attempted
      expect(smsProvider.calls).toHaveLength(1);
      expect(emailProvider.calls).toHaveLength(1);

      const emailCall = emailProvider.calls[0].message as RenderedEmail & OutboundMeta;
      expect(emailCall.subject).toBe('Your verification code');
      expect(emailCall.text).toBe('Your security code is 887766');

      const updatedRecord = await store.get(messageId);
      expect(updatedRecord).not.toBeNull();
      // Record shows all 3 attempts in order
      expect(updatedRecord?.chain.attempts).toHaveLength(3);
      expect(updatedRecord?.chain.attempts[0].channel).toBe('whatsapp');
      expect(updatedRecord?.chain.attempts[0].status).toBe('failed');

      expect(updatedRecord?.chain.attempts[1].channel).toBe('sms');
      expect(updatedRecord?.chain.attempts[1].status).toBe('failed');
      expect(updatedRecord?.chain.attempts[1].error).toBe(
        'Twilio SMS service unavailable (503)'
      );

      expect(updatedRecord?.chain.attempts[2].channel).toBe('email');
      expect(updatedRecord?.chain.attempts[2].status).toBe('sent');
      expect(updatedRecord?.chain.attempts[2].providerId).toBe('email_ok_114');

      expect(updatedRecord?.chain.status).toBe('sent');
      expect(updatedRecord?.status).toBe('sent');
    });

    it('sets chain.status = "failed" when all subsequent fallback providers fail immediately', async () => {
      const waProvider = createRecordingProvider('meta-wa', 'whatsapp');
      const smsProvider = createRecordingProvider('twilio-sms', 'sms', () =>
        Promise.resolve({
          ok: false,
          error: 'SMS network error',
        })
      );

      const messageId = 'msg_01J9FB00000000000000000015';
      const record: MessageRecord = {
        id: messageId,
        template: 'otpVerification',
        kind: 'otp',
        policy: { fallback: ['whatsapp', 'sms'], always: [] },
        chain: {
          status: 'failed',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              status: 'failed',
              error: 'WA error',
              at: '2026-09-20T10:00:00.000Z',
            },
          ],
        },
        always: [],
        status: 'failed',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:05.000Z',
      };
      await store.create(record);

      await kv.put(
        `in:${messageId}`,
        JSON.stringify({
          input: { code: '332211' },
          to: '+94770000015',
          locale: 'en',
        })
      );

      await advanceChain({
        id: messageId,
        reason: 'failed',
        env: { MESSAGES_KV: kv },
        options: {
          templates: testTemplates,
          providers: [waProvider, smsProvider],
        },
        store,
      });

      const updatedRecord = await store.get(messageId);
      expect(updatedRecord?.chain.status).toBe('failed');
      expect(updatedRecord?.status).toBe('failed');
      expect(updatedRecord?.chain.attempts).toHaveLength(2);
      expect(updatedRecord?.chain.attempts[1].error).toBe('SMS network error');

      // in:<id> deleted on exhaustion
      expect(await kv.get(`in:${messageId}`)).toBeNull();
    });
  });

  describe('Synchronous input pass-through vs KV in:<id>', () => {
    it('uses synchronous input argument directly when provided without reading KV', async () => {
      const waProvider = createRecordingProvider('meta-wa', 'whatsapp');
      const smsProvider = createRecordingProvider('twilio-sms', 'sms');

      const messageId = 'msg_01J9FB00000000000000000016';
      const record: MessageRecord = {
        id: messageId,
        template: 'otpVerification',
        kind: 'otp',
        policy: { fallback: ['whatsapp', 'sms'], always: [] },
        chain: {
          status: 'failed',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              status: 'failed',
              error: 'Immediate sync WA fail',
              at: '2026-09-20T10:00:00.000Z',
            },
          ],
        },
        always: [],
        status: 'failed',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:00.000Z',
      };
      await store.create(record);

      // KV in:<id> is NOT written
      expect(await kv.get(`in:${messageId}`)).toBeNull();

      // advanceChain is passed input directly from synchronous send path
      await advanceChain({
        id: messageId,
        reason: 'failed',
        env: { MESSAGES_KV: kv },
        options: {
          templates: testTemplates,
          providers: [waProvider, smsProvider],
        },
        store,
        input: {
          input: { code: '505050' },
          to: '+94770000016',
          locale: 'en',
        },
      });

      expect(smsProvider.calls).toHaveLength(1);
      const smsCall = smsProvider.calls[0].message as RenderedSms & OutboundMeta;
      expect(smsCall.text).toBe('Your authentication code is 505050. Valid for 5m.');
    });
  });

  describe('Custom Fallback Policies with Skipped Channels', () => {
    it('advances in exact order defined by policy.fallback (e.g. SMS first then WhatsApp)', async () => {
      const waProvider = createRecordingProvider('meta-wa', 'whatsapp');
      const smsProvider = createRecordingProvider('twilio-sms', 'sms');

      const customPolicy: DeliveryPolicy = { fallback: ['sms', 'whatsapp'], always: [] };
      const messageId = 'msg_01J9FB00000000000000000017';
      const record: MessageRecord = {
        id: messageId,
        template: 'alertNotification',
        kind: 'notification',
        policy: customPolicy,
        chain: {
          status: 'failed',
          attempts: [
            {
              channel: 'sms',
              provider: 'twilio-sms',
              status: 'failed',
              error: 'SMS blocked by recipient',
              at: '2026-09-20T10:00:00.000Z',
            },
          ],
        },
        always: [],
        status: 'failed',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:05.000Z',
      };
      await store.create(record);

      await kv.put(
        `in:${messageId}`,
        JSON.stringify({
          input: { text: 'High CPU usage detected' },
          to: '+94770000017',
          locale: 'en',
        })
      );

      await advanceChain({
        id: messageId,
        reason: 'failed',
        env: { MESSAGES_KV: kv },
        options: {
          templates: testTemplates,
          providers: [smsProvider, waProvider],
        },
        store,
      });

      // Next channel in policy ['sms', 'whatsapp'] after sms is whatsapp
      expect(waProvider.calls).toHaveLength(1);
      const waCall = waProvider.calls[0].message as RenderedWhatsApp & OutboundMeta;
      expect(waCall.text).toBe('[ALERT] High CPU usage detected');

      const updatedRecord = await store.get(messageId);
      expect(updatedRecord?.chain.attempts).toHaveLength(2);
      expect(updatedRecord?.chain.attempts[0].channel).toBe('sms');
      expect(updatedRecord?.chain.attempts[1].channel).toBe('whatsapp');
    });
  });
});
