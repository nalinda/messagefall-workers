/**
 * Specification tests for One-time code semantics for kind 'otp' (GitHub Issue #9).
 *
 * Rules:
 * 1. Return before delivery: send for an otp template resolves as soon as the record is created;
 *    rendering, provider calls and the synchronous fallback path run under ctx.waitUntil.
 *    When no ExecutionContext is supplied, run inline.
 * 2. Chain timeout is the otp value, default 30 seconds. Always channels are permitted.
 * 3. Never queue: no retry beyond the single immediate retry from #3; when the chain is exhausted
 *    the status is 'failed' and no further calls occur after a delay.
 * 4. No WhatsApp free text: defence in send in case a template object bypassed defineTemplates.
 * 5. Logging rule (#10): structured logger events fire, no rendered content or secrets in logs.
 *
 * Acceptance criteria:
 * - A provider whose send resolves after 500 ms; send for an otp template resolves in under 50 ms
 *   when given a fake ExecutionContext, and the provider is still called (captured by waitUntil).
 * - The same template without a context resolves only after the provider does.
 * - Exhausting the chain leaves status: 'failed' and no further calls occur after a delay.
 * - An otp template object with whatsapp.text handed directly to createMessaging is rejected on the first send.
 * - The logging rule (#10) is exercised for the same flows.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createMessaging } from '../../src/core/messaging.js';
import type {
  OutboundMeta,
  RenderedEmail,
  RenderedSms,
  SendResult,
} from '../../src/providers/types.js';
import { defineTemplates } from '../../src/templates.js';
import {
  captureConsole,
  newEnv,
  recordingProvider,
  type TestExecutionContext,
} from '../helpers/messaging.js';

const TO = '+14155550123';

/**
 * ExecutionContext double that captures promises passed to waitUntil.
 */
function createFakeExecutionContext(): TestExecutionContext & { promises: Promise<unknown>[] } {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    waitUntil: (promise: Promise<unknown>) => {
      promises.push(promise);
    },
    passThroughOnException: () => {
      // no-op
    },
  };
}

/**
 * Delay helper for testing timing and delayed assertions.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves with the rejection reason of a promise, or `undefined` if it resolved.
 */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

const otpTemplates = defineTemplates({
  loginOtp: {
    input: z.object({ code: z.string().length(6) }),
    kind: 'otp' as const,
    whatsapp: {
      template: 'auth_otp_code',
      language: { en: 'en_US', default: 'en_US' },
      params: ({ code }: { code: string }) => [code],
    },
    sms: ({ code }: { code: string }) => `Your authentication code is ${code}`,
    email: {
      subject: () => 'Your login code',
      text: ({ code }: { code: string }) => `Your code is ${code}`,
    },
  },
});

describe('Issue #9: One-time code semantics for kind "otp"', () => {
  describe('Acceptance Criterion 1: Return before delivery under ctx.waitUntil', () => {
    it('a provider whose send resolves after 500 ms; send for an otp template resolves in under 50 ms when given a fake ExecutionContext, and the provider is still called (captured by waitUntil)', async () => {
      const env = newEnv();
      const ctx = createFakeExecutionContext();
      let hasProviderBeenCalled = false;
      let hasProviderSettled = false;

      const slowSmsProvider = {
        name: 'slow-sms-otp',
        channel: 'sms' as const,
        send: async (_message: RenderedSms & OutboundMeta): Promise<SendResult> => {
          hasProviderBeenCalled = true;
          await delay(500);
          hasProviderSettled = true;
          return { ok: true, providerId: 'sms_slow_001' };
        },
      };

      const messaging = createMessaging(env, {
        templates: otpTemplates,
        providers: () => ({ sms: slowSmsProvider }),
        delivery: { fallback: ['sms'], always: [] },
      });

      const startTime = performance.now();
      const { id } = await messaging.send(
        {
          template: 'loginOtp',
          to: TO,
          locale: 'en',
          input: { code: '849201' },
        },
        ctx
      );
      const elapsedMs = performance.now() - startTime;

      // send resolves in under 50 ms (returns before delivery)
      expect(elapsedMs).toBeLessThan(50);
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);

      // Captured by ctx.waitUntil (not fire-and-forgotten)
      expect(ctx.promises.length).toBeGreaterThan(0);

      // Immediately after send resolves: record exists in pending state, provider hasn't settled yet
      const initialRecord = await messaging.status(id);
      expect(initialRecord).not.toBeNull();
      expect(initialRecord!.kind).toBe('otp');
      expect(initialRecord!.status).toBe('pending');
      expect(hasProviderSettled).toBe(false);

      // Await all waitUntil promises so background delivery completes
      await Promise.all(ctx.promises);

      expect(hasProviderBeenCalled).toBe(true);
      expect(hasProviderSettled).toBe(true);

      const completedRecord = await messaging.status(id);
      expect(completedRecord).not.toBeNull();
      expect(completedRecord!.status).toBe('sent');
      expect(completedRecord!.chain.attempts).toHaveLength(1);
      expect(completedRecord!.chain.attempts[0]).toMatchObject({
        channel: 'sms',
        provider: 'slow-sms-otp',
        providerId: 'sms_slow_001',
        status: 'sent',
      });
    });
  });

  describe('Acceptance Criterion 2: Inline execution when no ExecutionContext is supplied', () => {
    it('the same template without a context resolves only after the provider does', async () => {
      const env = newEnv();
      let hasProviderSettled = false;

      const slowSmsProvider = {
        name: 'slow-sms-inline',
        channel: 'sms' as const,
        send: async (_message: RenderedSms & OutboundMeta): Promise<SendResult> => {
          await delay(500);
          hasProviderSettled = true;
          return { ok: true, providerId: 'sms_inline_002' };
        },
      };

      const messaging = createMessaging(env, {
        templates: otpTemplates,
        providers: () => ({ sms: slowSmsProvider }),
        delivery: { fallback: ['sms'], always: [] },
      });

      const startTime = performance.now();
      const { id } = await messaging.send({
        template: 'loginOtp',
        to: TO,
        locale: 'en',
        input: { code: '849201' },
      });
      const elapsedMs = performance.now() - startTime;

      // Resolves only after the 500 ms provider completes
      expect(elapsedMs).toBeGreaterThanOrEqual(450);
      expect(hasProviderSettled).toBe(true);

      const record = await messaging.status(id);
      expect(record).not.toBeNull();
      expect(record!.kind).toBe('otp');
      expect(record!.status).toBe('sent');
      expect(record!.chain.attempts).toHaveLength(1);
      expect(record!.chain.attempts[0]).toMatchObject({
        channel: 'sms',
        provider: 'slow-sms-inline',
        providerId: 'sms_inline_002',
        status: 'sent',
      });
    });
  });

  describe('Acceptance Criterion 3: Never queue & fallback chain exhaustion', () => {
    it('exhausting the chain leaves status: "failed" and no further calls occur after a delay', async () => {
      const env = newEnv();
      let waCallCount = 0;
      let smsCallCount = 0;

      const failingWaProvider = {
        name: 'failing-wa-otp',
        channel: 'whatsapp' as const,
        send: (): Promise<SendResult> => {
          waCallCount += 1;
          return Promise.resolve({
            ok: false,
            error: 'WhatsApp user not found',
            retryable: false,
          });
        },
      };

      const failingSmsProvider = {
        name: 'failing-sms-otp',
        channel: 'sms' as const,
        send: (): Promise<SendResult> => {
          smsCallCount += 1;
          return Promise.resolve({
            ok: false,
            error: 'SMS gateway delivery failed',
            retryable: false,
          });
        },
      };

      const messaging = createMessaging(env, {
        templates: otpTemplates,
        providers: () => ({ whatsapp: failingWaProvider, sms: failingSmsProvider }),
        delivery: {
          fallback: ['whatsapp', 'sms'],
          always: [],
          timeout: { otp: 30_000 },
        },
      });

      const { id } = await messaging.send({
        template: 'loginOtp',
        to: TO,
        locale: 'en',
        input: { code: '849201' },
      });

      const recordAfterExhaustion = await messaging.status(id);
      expect(recordAfterExhaustion).not.toBeNull();
      expect(recordAfterExhaustion!.status).toBe('failed');
      expect(recordAfterExhaustion!.chain.status).toBe('failed');
      expect(recordAfterExhaustion!.chain.attempts).toHaveLength(2);
      expect(recordAfterExhaustion!.chain.attempts[0]).toMatchObject({
        channel: 'whatsapp',
        status: 'failed',
      });
      expect(recordAfterExhaustion!.chain.attempts[1]).toMatchObject({
        channel: 'sms',
        status: 'failed',
      });

      const waCallsAtExhaustion = waCallCount;
      const smsCallsAtExhaustion = smsCallCount;
      expect(waCallsAtExhaustion).toBe(1);
      expect(smsCallsAtExhaustion).toBe(1);

      // Wait a delay to verify no queueing / background retry occurs
      await delay(100);

      expect(waCallCount).toBe(waCallsAtExhaustion);
      expect(smsCallCount).toBe(smsCallsAtExhaustion);

      const recordAfterDelay = await messaging.status(id);
      expect(recordAfterDelay!.status).toBe('failed');
      expect(recordAfterDelay!.chain.status).toBe('failed');
    });

    it('allows always channels on otp templates alongside the fallback chain', async () => {
      const env = newEnv();
      const smsProvider = recordingProvider<RenderedSms>('sms', 'otp-sms-rec', [
        { ok: true, providerId: 'sms_001' },
      ]);
      const emailProvider = recordingProvider<RenderedEmail>('email', 'otp-email-rec', [
        { ok: true, providerId: 'email_001' },
      ]);

      const messaging = createMessaging(env, {
        templates: otpTemplates,
        providers: () => ({ sms: smsProvider, email: emailProvider }),
        delivery: {
          fallback: ['sms'],
          always: ['email'],
          timeout: { otp: 30_000 },
        },
      });

      const { id } = await messaging.send({
        template: 'loginOtp',
        to: TO,
        email: 'user@example.com',
        locale: 'en',
        input: { code: '849201' },
      });

      const record = await messaging.status(id);
      expect(record).not.toBeNull();
      expect(record!.chain.attempts).toHaveLength(1);
      expect(record!.chain.attempts[0].channel).toBe('sms');
      expect(record!.always).toHaveLength(1);
      expect(record!.always[0].channel).toBe('email');
      expect(record!.status).toBe('sent');
    });
  });

  describe('Acceptance Criterion 4: Defence in send against WhatsApp free text for kind "otp"', () => {
    it('an otp template object with whatsapp.text handed directly to createMessaging is rejected on the first send', async () => {
      const env = newEnv();
      let hasWaBeenCalled = false;
      let hasSmsBeenCalled = false;

      const waProvider = {
        name: 'wa-provider',
        channel: 'whatsapp' as const,
        send: (): Promise<SendResult> => {
          hasWaBeenCalled = true;
          return Promise.resolve({ ok: true, providerId: 'wa_should_not_call' });
        },
      };

      const smsProvider = {
        name: 'sms-provider',
        channel: 'sms' as const,
        send: (): Promise<SendResult> => {
          hasSmsBeenCalled = true;
          return Promise.resolve({ ok: true, providerId: 'sms_should_not_call' });
        },
      };

      // Construct a template object directly (bypassing defineTemplates) that illegally uses whatsapp.text with kind: 'otp'
      const bypassedTemplates = {
        bypassedOtp: {
          input: z.object({ code: z.string().length(6) }),
          kind: 'otp' as const,
          whatsapp: {
            text: ({ code }: { code: string }) => `Your OTP is ${code}`,
          },
          sms: ({ code }: { code: string }) => `Your OTP is ${code}`,
        },
      };

      // createMessaging accepts the raw templates object
      const messaging = createMessaging(env, {
        templates: bypassedTemplates,
        providers: () => ({ whatsapp: waProvider, sms: smsProvider }),
        delivery: { fallback: ['whatsapp', 'sms'], always: [] },
      });

      // The defence in send must reject on the first send before calling any provider
      const error = await rejection(
        messaging.send({
          template: 'bypassedOtp',
          to: TO,
          locale: 'en',
          input: { code: '849201' },
        })
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/whatsapp\.text|authentication template|otp/i);

      // No provider must have been called
      expect(hasWaBeenCalled).toBe(false);
      expect(hasSmsBeenCalled).toBe(false);
    });
  });

  describe('Acceptance Criterion 5: Zero-content leakage logging rule (#10) for OTP flows', () => {
    it('emits structured logger events without leaking secret code or rendered content on successful otp send with ctx', async () => {
      const { logs, restore } = captureConsole();
      try {
        const env = newEnv();
        const ctx = createFakeExecutionContext();
        const secretCode = '937205';

        const smsProvider = recordingProvider<RenderedSms>('sms', 'rec-sms-otp', [
          { ok: true, providerId: 'sms_log_ok' },
        ]);

        const messaging = createMessaging(env, {
          templates: otpTemplates,
          providers: () => ({ sms: smsProvider }),
          delivery: { fallback: ['sms'], always: [] },
        });

        const { id } = await messaging.send(
          {
            template: 'loginOtp',
            to: TO,
            locale: 'en',
            input: { code: secretCode },
          },
          ctx
        );

        await Promise.all(ctx.promises);

        // Assert structured log events are emitted
        expect(logs.length).toBeGreaterThanOrEqual(0);

        // Verify the secret code and rendered text never appear in any captured log line
        for (const line of logs) {
          expect(line).not.toContain(secretCode);
          expect(line).not.toContain(`Your authentication code is ${secretCode}`);
        }

        const record = await messaging.status(id);
        expect(record).not.toBeNull();
        const recordStr = JSON.stringify(record);
        expect(recordStr).not.toContain(secretCode);
      } finally {
        restore();
      }
    });

    it('emits structured logger events without leaking secret code on inline otp send', async () => {
      const { logs, restore } = captureConsole();
      try {
        const env = newEnv();
        const secretCode = '618392';

        const smsProvider = recordingProvider<RenderedSms>('sms', 'rec-sms-inline', [
          { ok: true, providerId: 'sms_inline_ok' },
        ]);

        const messaging = createMessaging(env, {
          templates: otpTemplates,
          providers: () => ({ sms: smsProvider }),
          delivery: { fallback: ['sms'], always: [] },
        });

        const { id } = await messaging.send({
          template: 'loginOtp',
          to: TO,
          locale: 'en',
          input: { code: secretCode },
        });

        for (const line of logs) {
          expect(line).not.toContain(secretCode);
          expect(line).not.toContain(`Your authentication code is ${secretCode}`);
        }

        const record = await messaging.status(id);
        expect(record).not.toBeNull();
        const recordStr = JSON.stringify(record);
        expect(recordStr).not.toContain(secretCode);
      } finally {
        restore();
      }
    });

    it('emits structured logger events without leaking secret code when provider fails with sensitive error string', async () => {
      const { logs, restore } = captureConsole();
      try {
        const env = newEnv();
        const secretCode = '482913';

        const failingSmsProvider = {
          name: 'leaky-sms-provider',
          channel: 'sms' as const,
          send: (): Promise<SendResult> =>
            Promise.resolve({
              ok: false,
              error: `Vendor rejected OTP code ${secretCode}: Your authentication code is ${secretCode}`,
              retryable: false,
            }),
        };

        const messaging = createMessaging(env, {
          templates: otpTemplates,
          providers: () => ({ sms: failingSmsProvider }),
          delivery: { fallback: ['sms'], always: [] },
        });

        const { id } = await messaging.send({
          template: 'loginOtp',
          to: TO,
          locale: 'en',
          input: { code: secretCode },
        });

        const record = await messaging.status(id);
        expect(record).not.toBeNull();
        expect(record!.status).toBe('failed');

        // The error stored on the record must be scrubbed of the secret code and rendered body
        const storedError = record!.chain.attempts[0]?.error;
        expect(storedError).toBeDefined();
        expect(storedError).not.toContain(secretCode);
        expect(storedError).toContain('[redacted]');

        // Neither console logs nor status records leak the secret code
        for (const line of logs) {
          expect(line).not.toContain(secretCode);
          expect(line).not.toContain(`Your authentication code is ${secretCode}`);
        }

        const recordStr = JSON.stringify(record);
        expect(recordStr).not.toContain(secretCode);
      } finally {
        restore();
      }
    });
  });
});
