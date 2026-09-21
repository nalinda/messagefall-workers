/**
 * Integration tests under wrangler dev (GitHub Issue #15).
 *
 * Exercises the example Worker under wrangler with real KV and Durable Object emulation:
 * - send, status, webhook, fallback, timer alarm, OTP early-return, and storage cleanup.
 *
 * Scenarios covered:
 * 1. Send notification template (`orderUpdate`); record shows chain `whatsapp` and always `email`.
 * 2. Post a Meta-shaped `failed` status for WhatsApp attempt (dev bypass on); record shows SMS attempt.
 * 3. Send with first channel never reporting status; advance past timeout; SMS attempt appears
 *    from alarm. Runs against its own entrypoint with a 250ms chain timeout: the example ships
 *    realistic timeouts, so only this scenario gets a fast alarm — and the webhook-driven
 *    scenarios above cannot be passed by a timer firing behind their backs.
 * 4. Send OTP template (`loginCode`); response time under 100 ms via ctx.waitUntil; delivery still happens.
 * 5. Post `delivered` for SMS attempt; chain and overall status `delivered`; timer storage empty.
 * 7. POST /send with `delivery: 'all'` yields three parallel attempts.
 * 8. Unsigned webhook without dev bypass returns 401.
 *
 * @module
 */

import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { IntegrationHarness } from './harness.js';

const FAST_TIMER_ENTRYPOINT = path.join(import.meta.dir, 'fixtures/fast-timer-worker.ts');

const TEST_TIMEOUT = 15_000;
const SETTLE_TIMEOUT = 2500;

describe('Issue #15: Integration tests under wrangler dev', () => {
  let harness: IntegrationHarness;
  let harnessNoBypass: IntegrationHarness;
  // Only scenario 3 wants a timer that fires in milliseconds; the example's own timeouts stay
  // realistic so the webhook-driven scenarios really do test the webhook path.
  let harnessFastTimer: IntegrationHarness;
  // Scenario 5 asserts the timer left NO state behind, and that check reads the whole Durable
  // Object directory — so it needs an instance no other scenario's still-armed timer writes to.
  let harnessTimerCleanup: IntegrationHarness;

  beforeAll(async () => {
    harness = await IntegrationHarness.start({
      vars: { MESSAGING_DEV_UNSIGNED: 'true' },
    });
    harnessNoBypass = await IntegrationHarness.start({
      vars: { MESSAGING_DEV_UNSIGNED: 'false' },
    });
    harnessFastTimer = await IntegrationHarness.start({
      vars: { MESSAGING_DEV_UNSIGNED: 'true' },
      entrypoint: FAST_TIMER_ENTRYPOINT,
    });
    harnessTimerCleanup = await IntegrationHarness.start({
      vars: { MESSAGING_DEV_UNSIGNED: 'true' },
    });
  });

  afterAll(async () => {
    await Promise.all([
      harness.stop(),
      harnessNoBypass.stop(),
      harnessFastTimer.stop(),
      harnessTimerCleanup.stop(),
    ]);
  });

  it(
    'Scenario 1: Send notification template; record shows chain whatsapp and always email',
    async () => {
      const sendRes = await harness.send({
        template: 'orderUpdate',
        to: '+94771234567',
        email: 'shopper@example.com',
        locale: 'en',
        input: {
          orderId: 'ORD-1001',
          status: 'shipped',
        },
      });

      expect(sendRes.status).toBe(200);
      const body = (await sendRes.json()) as { id: string };
      expect(body.id).toBeDefined();
      expect(body.id.startsWith('msg_')).toBe(true);

      const record = await harness.waitForRecord(
        body.id,
        (r) => r.chain.attempts.length === 1 && r.always.length === 1,
        SETTLE_TIMEOUT
      );

      expect(record.template).toBe('orderUpdate');
      expect(record.kind).toBe('notification');
      expect(record.chain.attempts[0].channel).toBe('whatsapp');
      expect(record.chain.attempts[0].status).toBe('sent');
      expect(record.always[0].channel).toBe('email');
      expect(record.always[0].status).toBe('sent');
      expect(record.chain.status).toBe('sent');
    },
    TEST_TIMEOUT
  );

  it(
    'Scenario 2: Post a Meta-shaped failed status for the WhatsApp attempt (dev bypass on); record shows an SMS attempt',
    async () => {
      // 1. Send notification message
      const sendRes = await harness.send({
        template: 'orderUpdate',
        to: '+94771234568',
        email: 'shopper2@example.com',
        locale: 'en',
        input: {
          orderId: 'ORD-1002',
          status: 'dispatched',
        },
      });

      expect(sendRes.status).toBe(200);
      const { id } = (await sendRes.json()) as { id: string };

      const initialRecord = await harness.waitForRecord(
        id,
        (r) => r.chain.attempts.length === 1,
        SETTLE_TIMEOUT
      );
      const waProviderId = initialRecord.chain.attempts[0].providerId ?? '';
      expect(waProviderId).toBeDefined();

      // 2. Post Meta-shaped failed webhook payload
      const metaFailedPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA_ID_TEST',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '15550001111',
                    phone_number_id: '123456789012345',
                  },
                  statuses: [
                    {
                      id: waProviderId,
                      status: 'failed',
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      recipient_id: '+94771234568',
                      errors: [{ code: 131_026, title: 'Message undeliverable' }],
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const webhookRes = await harness.webhook('console-whatsapp', metaFailedPayload);
      expect(webhookRes.status).toBe(200);

      // 3. Fallback chain advances to SMS
      const advancedRecord = await harness.waitForRecord(
        id,
        (r) => r.chain.attempts.length === 2,
        SETTLE_TIMEOUT
      );
      expect(advancedRecord.chain.attempts[0].channel).toBe('whatsapp');
      expect(advancedRecord.chain.attempts[0].status).toBe('failed');
      expect(advancedRecord.chain.attempts[1].channel).toBe('sms');
      expect(advancedRecord.chain.attempts[1].status).toBe('sent');
      expect(advancedRecord.chain.status).toBe('sent');
    },
    TEST_TIMEOUT
  );

  it(
    'Scenario 3: Send with first channel never reporting status; advance past timeout; SMS attempt appears from the alarm',
    async () => {
      // Send notification message without sending status webhook
      const sendRes = await harnessFastTimer.send({
        template: 'orderUpdate',
        to: '+94771234569',
        email: 'shopper3@example.com',
        locale: 'en',
        input: {
          orderId: 'ORD-1003',
          status: 'in-transit',
        },
      });

      expect(sendRes.status).toBe(200);
      const { id } = (await sendRes.json()) as { id: string };

      const initialRecord = await harnessFastTimer.waitForRecord(
        id,
        (r) => r.chain.attempts.length === 1,
        SETTLE_TIMEOUT
      );
      expect(initialRecord.chain.attempts[0].channel).toBe('whatsapp');
      expect(initialRecord.chain.attempts[0].status).toBe('sent');

      // Poll status endpoint with a deadline for the alarm to trigger and advance chain to SMS
      const timedOutRecord = await harnessFastTimer.waitForRecord(
        id,
        (r) => r.chain.attempts.length === 2,
        SETTLE_TIMEOUT
      );

      expect(timedOutRecord.chain.attempts[0].channel).toBe('whatsapp');
      expect(timedOutRecord.chain.attempts[1].channel).toBe('sms');
      expect(timedOutRecord.chain.attempts[1].status).toBe('sent');
    },
    TEST_TIMEOUT
  );

  it(
    'Scenario 4: Send loginCode; response time under 100 ms while providers are slow; delivery still happens',
    async () => {
      const start = performance.now();
      const sendRes = await harness.send({
        template: 'loginCode',
        to: '+94779998888',
        locale: 'en',
        input: {
          code: '581932',
        },
      });
      const elapsedMs = performance.now() - start;

      expect(sendRes.status).toBe(200);
      expect(elapsedMs).toBeLessThan(100);

      const { id } = (await sendRes.json()) as { id: string };
      expect(id).toBeDefined();

      const record = await harness.waitForRecord(
        id,
        (r) => r.chain.attempts.length === 1,
        SETTLE_TIMEOUT
      );
      expect(record.template).toBe('loginCode');
      expect(record.kind).toBe('otp');
      expect(record.chain.attempts[0].channel).toBe('whatsapp');
      expect(record.chain.attempts[0].status).toBe('sent');
    },
    TEST_TIMEOUT
  );

  it(
    'Scenario 5: Post a delivered status for the SMS attempt; chain and overall status delivered; timer storage empty',
    async () => {
      // 1. Send message and advance to SMS
      const sendRes = await harnessTimerCleanup.send({
        template: 'orderUpdate',
        to: '+94771234570',
        email: 'shopper5@example.com',
        locale: 'en',
        input: {
          orderId: 'ORD-1005',
          status: 'delivered-test',
        },
      });
      const { id } = (await sendRes.json()) as { id: string };

      const initial = await harnessTimerCleanup.waitForRecord(
        id,
        (r) => r.chain.attempts.length === 1,
        SETTLE_TIMEOUT
      );
      const waProviderId = initial.chain.attempts[0].providerId ?? '';

      // Fail WhatsApp attempt
      await harnessTimerCleanup.webhook('console-whatsapp', {
        providerId: waProviderId,
        status: 'failed',
      });

      const advanced = await harnessTimerCleanup.waitForRecord(
        id,
        (r) => r.chain.attempts.length === 2,
        SETTLE_TIMEOUT
      );
      const smsProviderId = advanced.chain.attempts[1].providerId ?? '';

      // 2. Deliver SMS attempt
      const smsRes = await harnessTimerCleanup.webhook('console-sms', {
        providerId: smsProviderId,
        status: 'delivered',
      });
      expect(smsRes.status).toBe(200);

      // 3. Chain and overall status are delivered
      const settled = await harnessTimerCleanup.waitForRecord(
        id,
        (r) => r.chain.status === 'delivered',
        SETTLE_TIMEOUT
      );
      expect(settled.chain.status).toBe('delivered');
      expect(settled.status).toBe('delivered');

      // 4. Timer storage empty
      const isEmpty = harnessTimerCleanup.isTimerStorageEmpty();
      expect(isEmpty).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    "Scenario 7: POST /send with delivery: 'all' yields three parallel attempts",
    async () => {
      const sendRes = await harness.send({
        template: 'orderUpdate',
        to: '+94771234571',
        email: 'shopper7@example.com',
        locale: 'en',
        delivery: 'all',
        input: {
          orderId: 'ORD-1007',
          status: 'parallel-test',
        },
      });

      expect(sendRes.status).toBe(200);
      const { id } = (await sendRes.json()) as { id: string };

      const record = await harness.waitForRecord(id, (r) => r.always.length === 3, SETTLE_TIMEOUT);
      expect(record.chain.attempts).toHaveLength(0);
      expect(record.always).toHaveLength(3);

      const channels = record.always.map((a) => a.channel).toSorted((a, b) => a.localeCompare(b));
      expect(channels).toEqual(['email', 'sms', 'whatsapp']);
    },
    TEST_TIMEOUT
  );

  it(
    'Scenario 8: Unsigned webhook without the dev bypass returns 401',
    async () => {
      const webhookRes = await harnessNoBypass.webhook('console-whatsapp', {
        providerId: 'console_unauthorized_1',
        status: 'delivered',
      });

      expect(webhookRes.status).toBe(401);
    },
    TEST_TIMEOUT
  );
});
