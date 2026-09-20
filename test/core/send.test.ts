/**
 * Failing tests for the createMessaging send pipeline (GitHub Issue #3).
 *
 * Acceptance criteria:
 * - With console providers and policy { fallback: ['whatsapp','sms'], always: ['email'] }, a
 *   notification send produces one chain attempt on whatsapp and one always attempt on email,
 *   each naming the provider, with the correct rendered content passed to each provider, and
 *   no sms attempt.
 * - A channel in both parts is sent once and recorded under always.
 * - An invalid `to` and an invalid `input` are rejected before any provider is called.
 * - A retryable failure is retried exactly once.
 * - Two createMessaging calls with the same env build providers once.
 */

import { beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { PolicyError } from '../../src/core/policy.js';
import { kvStatusStore } from '../../src/core/status.js';
import { consoleProvider } from '../../src/providers/console/index.js';
import type {
  Channel,
  OutboundMeta,
  RenderedEmail,
  RenderedSms,
  RenderedWhatsApp,
  SendResult,
} from '../../src/providers/types.js';
import { defineTemplates, TemplateValidationError } from '../../src/templates.js';
import type { MessagingEnv } from '../../src/types.js';
import {
  loadMessagingApi,
  memoryKV,
  type MessagingApi,
  type ProviderSet,
  type RecordingProvider,
  recordingProvider,
  type StatusCallbackEvent,
  type TestExecutionContext,
} from '../helpers/messaging.js';

const orderInput = z.object({ name: z.string(), orderId: z.string() });
type OrderInput = z.infer<typeof orderInput>;

/**
 * Notification template defining all three channels. WhatsApp uses free text so the
 * rendered payload and OutboundMeta do not both carry a `template` key.
 */
const templates = defineTemplates({
  orderUpdate: {
    input: orderInput,
    kind: 'notification' as const,
    whatsapp: {
      text: ({ name, orderId }: OrderInput, locale: string) =>
        `[${locale}] ${name}, order ${orderId} has shipped`,
    },
    sms: ({ name, orderId }: OrderInput) => `${name}: order ${orderId} shipped`,
    email: {
      subject: ({ orderId }: OrderInput) => `Order ${orderId} shipped`,
      text: ({ name, orderId }: OrderInput) => `Hi ${name}, your order ${orderId} is on its way.`,
    },
  },
  smsOnly: {
    input: z.object({ body: z.string() }),
    kind: 'notification' as const,
    sms: ({ body }: { body: string }) => body,
  },
  loginCode: {
    input: z.object({ code: z.string().length(6) }),
    kind: 'otp' as const,
    sms: ({ code }: { code: string }) => `Your code is ${code}`,
  },
  loginCodeWa: {
    input: z.object({ code: z.string().length(6) }),
    kind: 'otp' as const,
    whatsapp: {
      template: 'auth_code',
      language: { en: 'en_US', default: 'en_US' },
      params: ({ code }: { code: string }) => [code],
    },
    sms: ({ code }: { code: string }) => `Your code is ${code}`,
  },
  emailFirst: {
    input: orderInput,
    kind: 'notification' as const,
    delivery: { fallback: ['email', 'sms'], always: [] },
    whatsapp: {
      text: ({ orderId }: OrderInput) => `Order ${orderId} update`,
    },
    sms: ({ orderId }: OrderInput) => `Order ${orderId} update`,
    email: {
      subject: ({ orderId }: OrderInput) => `Order ${orderId} update`,
      text: ({ name }: OrderInput) => `Hi ${name}`,
    },
  },
});

const TO = '+14155550123';
const INPUT: OrderInput = { name: 'Ann', orderId: 'A-100' };

function consoleSet(): ProviderSet {
  return {
    whatsapp: consoleProvider<RenderedWhatsApp>({ channel: 'whatsapp', name: 'console-wa' }),
    sms: consoleProvider<RenderedSms>({ channel: 'sms', name: 'console-sms' }),
    email: consoleProvider<RenderedEmail>({ channel: 'email', name: 'console-email' }),
  };
}

function newEnv(): MessagingEnv {
  return { MESSAGES_KV: memoryKV() };
}

/**
 * Silences console.log for the duration of a test; returns the captured lines and a restore fn.
 */
function silenceConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]): void => {
    logs.push(args.map(String).join(' '));
  };
  return {
    logs,
    restore: () => {
      console.log = originalLog;
    },
  };
}

/**
 * ExecutionContext double that collects everything handed to `waitUntil`.
 */
function testContext(): TestExecutionContext & { promises: Promise<unknown>[] } {
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
 * Provider whose `send` records the call and blocks until `release()` is called.
 */
function gatedProvider<R>(channel: Channel, name: string, providerId: string) {
  const calls: (R & OutboundMeta)[] = [];
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  return {
    calls,
    release: () => {
      release();
    },
    provider: {
      name,
      channel,
      send: async (message: R & OutboundMeta): Promise<SendResult> => {
        calls.push(message);
        await gate;
        return { ok: true, providerId };
      },
    },
  };
}

/**
 * Polls until `isDone` returns true or `timeoutMs` elapses.
 */
async function waitFor(isDone: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!isDone() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

/**
 * Three recording providers, one per channel, plus the set to hand to createMessaging.
 */
  function threeProviders(): {
    wa: RecordingProvider<RenderedWhatsApp>;
    sms: RecordingProvider<RenderedSms>;
    email: RecordingProvider<RenderedEmail>;
    set: ProviderSet;
  } {
    const wa = recordingProvider<RenderedWhatsApp>('whatsapp', 'rec-wa');
    const sms = recordingProvider<RenderedSms>('sms', 'rec-sms');
    const email = recordingProvider<RenderedEmail>('email', 'rec-email');
    return { wa, sms, email, set: { whatsapp: wa, sms, email } };
  }

describe('Issue #3: createMessaging send pipeline', () => {
  let api: MessagingApi;

  beforeAll(async () => {
    api = await loadMessagingApi();
  });

  describe('chain and always attempts with console providers', () => {
    it('sends one chain attempt on whatsapp and one always attempt on email, none on sms', async () => {
      const set = consoleSet();
      const waSpy = spyOn(set.whatsapp!, 'send');
      const smsSpy = spyOn(set.sms!, 'send');
      const emailSpy = spyOn(set.email!, 'send');
      const silenced = silenceConsole();

      try {
        const messaging = api.createMessaging(newEnv(), {
          templates,
          providers: () => set,
          delivery: { fallback: ['whatsapp', 'sms'], always: ['email'] },
        });

        const { id } = await messaging.send({
          template: 'orderUpdate',
          to: TO,
          locale: 'en',
          input: INPUT,
        });

        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);

        // Exactly one call to each of whatsapp and email; sms untouched.
        expect(waSpy).toHaveBeenCalledTimes(1);
        expect(emailSpy).toHaveBeenCalledTimes(1);
        expect(smsSpy).toHaveBeenCalledTimes(0);

        // Correct rendered content and outbound metadata reached each provider.
        const waCall = waSpy.mock.calls[0][0];
        expect(waCall.text).toBe('[en] Ann, order A-100 has shipped');
        expect(waCall).toMatchObject({
          to: TO,
          messageId: id,
          template: 'orderUpdate',
          kind: 'notification',
          locale: 'en',
        });

        const emailCall = emailSpy.mock.calls[0][0];
        expect(emailCall.subject).toBe('Order A-100 shipped');
        expect(emailCall.text).toBe('Hi Ann, your order A-100 is on its way.');
        expect(emailCall).toMatchObject({
          to: TO,
          messageId: id,
          template: 'orderUpdate',
          kind: 'notification',
          locale: 'en',
        });

        // Record: one chain attempt on whatsapp, one always attempt on email, each naming its provider.
        const record = await messaging.status(id);
        expect(record).not.toBeNull();
        expect(record!.template).toBe('orderUpdate');
        expect(record!.kind).toBe('notification');
        expect(record!.policy).toEqual({ fallback: ['whatsapp', 'sms'], always: ['email'] });

        expect(record!.chain.attempts).toHaveLength(1);
        expect(record!.chain.attempts[0]).toMatchObject({
          channel: 'whatsapp',
          provider: 'console-wa',
          status: 'sent',
        });
        expect(record!.chain.attempts[0].providerId).toBe(`console_${id}`);

        expect(record!.always).toHaveLength(1);
        expect(record!.always[0]).toMatchObject({
          channel: 'email',
          provider: 'console-email',
          status: 'sent',
        });

        const allAttempts = [...record!.chain.attempts, ...record!.always];
        expect(allAttempts.some((a) => a.channel === 'sms')).toBe(false);

        expect(record!.chain.status).toBe('sent');
        expect(record!.status).toBe('sent');
      } finally {
        silenced.restore();
      }
    });

    it('calls onStatus once per attempt with id, channel, provider and status', async () => {
      const set = consoleSet();
      const silenced = silenceConsole();
      const events: StatusCallbackEvent[] = [];

      try {
        const messaging = api.createMessaging(newEnv(), {
          templates,
          providers: () => set,
          delivery: { fallback: ['whatsapp', 'sms'], always: ['email'] },
          onStatus: (event) => {
            events.push(event);
          },
        });

        const { id } = await messaging.send({
          template: 'orderUpdate',
          to: TO,
          locale: 'en',
          input: INPUT,
        });

        const sorted = events.toSorted((a, b) => a.channel.localeCompare(b.channel));
        expect(sorted).toEqual([
          { id, channel: 'email', provider: 'console-email', status: 'sent' },
          { id, channel: 'whatsapp', provider: 'console-wa', status: 'sent' },
        ]);
      } finally {
        silenced.restore();
      }
    });
  });

  describe('rendered payload and outbound meta do not collide', () => {
    it('hands a WhatsApp otp provider the full Meta template config, not the catalogue name', async () => {
      const wa = recordingProvider<RenderedWhatsApp>('whatsapp', 'rec-wa');
      const messaging = api.createMessaging(newEnv(), {
        templates,
        providers: () => ({ whatsapp: wa }),
        delivery: { fallback: ['whatsapp'], always: [] },
      });

      const { id } = await messaging.send({
        template: 'loginCodeWa',
        to: TO,
        locale: 'en',
        input: { code: '654321' },
      });

      expect(wa.calls).toHaveLength(1);
      const call = wa.calls[0];
      // Read through the rendered type: the contract's `R & OutboundMeta` collapses `template`.
      const rendered: RenderedWhatsApp = call;
      expect(rendered.template).toEqual({ name: 'auth_code', language: 'en_US', params: ['654321'] });
      expect(call).toMatchObject({ to: TO, messageId: id, kind: 'otp', locale: 'en' });
      expect(call.text).toBeUndefined();

      const record = await messaging.status(id);
      expect(record!.template).toBe('loginCodeWa');
      expect(record!.chain.attempts[0]).toMatchObject({ channel: 'whatsapp', status: 'sent' });
    });
  });

  describe('chain advance on a failed chain attempt', () => {
    it('tries the next fallback channel when the first fails and records both attempts', async () => {
      const wa = recordingProvider<RenderedWhatsApp>('whatsapp', 'dead-wa', [
        { ok: false, error: 'number not on whatsapp' },
      ]);
      const sms = recordingProvider<RenderedSms>('sms', 'rec-sms', [
        { ok: true, providerId: 'sms-after-wa' },
      ]);
      const email = recordingProvider<RenderedEmail>('email', 'rec-email');
      const events: StatusCallbackEvent[] = [];

      const messaging = api.createMessaging(newEnv(), {
        templates,
        providers: () => ({ whatsapp: wa, sms, email }),
        delivery: { fallback: ['whatsapp', 'sms', 'email'], always: [] },
        onStatus: (event) => {
          events.push(event);
        },
      });

      const { id } = await messaging.send({
        template: 'orderUpdate',
        to: TO,
        locale: 'en',
        input: INPUT,
      });

      expect(wa.calls).toHaveLength(1);
      expect(sms.calls).toHaveLength(1);
      expect(sms.calls[0].text).toBe('Ann: order A-100 shipped');
      expect(email.calls).toHaveLength(0);

      const record = await messaging.status(id);
      expect(record).not.toBeNull();
      expect(record!.chain.attempts).toHaveLength(2);
      expect(record!.chain.attempts[0]).toMatchObject({
        channel: 'whatsapp',
        provider: 'dead-wa',
        status: 'failed',
        error: 'number not on whatsapp',
      });
      expect(record!.chain.attempts[1]).toMatchObject({
        channel: 'sms',
        provider: 'rec-sms',
        providerId: 'sms-after-wa',
        status: 'sent',
      });
      expect(record!.always).toHaveLength(0);
      expect(record!.chain.status).toBe('sent');
      expect(record!.status).toBe('sent');
      expect(events).toEqual([
        { id, channel: 'whatsapp', provider: 'dead-wa', status: 'failed' },
        { id, channel: 'sms', provider: 'rec-sms', status: 'sent' },
      ]);
    });
  });

  describe('channel present in both fallback and always', () => {
    it('sends the channel once and records it only under always', async () => {
      const set = consoleSet();
      const waSpy = spyOn(set.whatsapp!, 'send');
      const emailSpy = spyOn(set.email!, 'send');
      const silenced = silenceConsole();

      try {
        const messaging = api.createMessaging(newEnv(), {
          templates,
          providers: () => set,
          delivery: { fallback: ['whatsapp', 'email'], always: ['email'] },
        });

        const { id } = await messaging.send({
          template: 'orderUpdate',
          to: TO,
          locale: 'en',
          input: INPUT,
        });

        expect(emailSpy).toHaveBeenCalledTimes(1);
        expect(waSpy).toHaveBeenCalledTimes(1);

        const record = await messaging.status(id);
        expect(record).not.toBeNull();
        expect(record!.policy).toEqual({ fallback: ['whatsapp'], always: ['email'] });

        const emailInAlways = record!.always.filter((a) => a.channel === 'email');
        const emailInChain = record!.chain.attempts.filter((a) => a.channel === 'email');
        expect(emailInAlways).toHaveLength(1);
        expect(emailInChain).toHaveLength(0);
        expect(emailInAlways[0].provider).toBe('console-email');
      } finally {
        silenced.restore();
      }
    });
  });

  describe('delivery resolution: send override, template override, defined channels', () => {
    it('a send-level delivery override replaces the configured default for that send', async () => {
      const { wa, sms, email, set } = threeProviders();
      const messaging = api.createMessaging(newEnv(), {
        templates,
        providers: () => set,
        delivery: { fallback: ['whatsapp', 'sms'], always: ['email'] },
      });

      const { id } = await messaging.send({
        template: 'orderUpdate',
        to: TO,
        locale: 'en',
        input: INPUT,
        delivery: { fallback: ['sms'], always: [] },
      });

      expect(sms.calls).toHaveLength(1);
      expect(wa.calls).toHaveLength(0);
      expect(email.calls).toHaveLength(0);

      const record = await messaging.status(id);
      expect(record).not.toBeNull();
      expect(record!.policy).toEqual({ fallback: ['sms'], always: [] });
      expect(record!.chain.attempts).toHaveLength(1);
      expect(record!.chain.attempts[0]).toMatchObject({ channel: 'sms', provider: 'rec-sms' });
      expect(record!.always).toHaveLength(0);
    });

    it("a template's own delivery wins over the configured default when no send override is given", async () => {
      const { wa, sms, email, set } = threeProviders();
      const messaging = api.createMessaging(newEnv(), {
        templates,
        providers: () => set,
        delivery: { fallback: ['whatsapp', 'sms'], always: [] },
      });

      const { id } = await messaging.send({
        template: 'emailFirst',
        to: TO,
        locale: 'en',
        input: INPUT,
      });

      expect(email.calls).toHaveLength(1);
      expect(email.calls[0].subject).toBe('Order A-100 update');
      expect(wa.calls).toHaveLength(0);
      expect(sms.calls).toHaveLength(0);

      const record = await messaging.status(id);
      expect(record).not.toBeNull();
      expect(record!.policy).toEqual({ fallback: ['email', 'sms'], always: [] });
      expect(record!.chain.attempts[0]).toMatchObject({ channel: 'email', provider: 'rec-email' });
    });

    it('sends to the channel the template defines, not blindly to fallback[0] from config', async () => {
      const { wa, sms, email, set } = threeProviders();
      const messaging = api.createMessaging(newEnv(), {
        templates,
        providers: () => set,
        delivery: { fallback: ['whatsapp', 'sms'], always: [] },
      });

      const { id } = await messaging.send({
        template: 'smsOnly',
        to: TO,
        locale: 'en',
        input: { body: 'only sms here' },
      });

      expect(sms.calls).toHaveLength(1);
      expect(sms.calls[0].text).toBe('only sms here');
      expect(wa.calls).toHaveLength(0);
      expect(email.calls).toHaveLength(0);

      const record = await messaging.status(id);
      expect(record).not.toBeNull();
      expect(record!.policy).toEqual({ fallback: ['sms'], always: [] });
      expect(record!.chain.attempts).toHaveLength(1);
      expect(record!.chain.attempts[0]).toMatchObject({ channel: 'sms', provider: 'rec-sms' });
    });

    it('rejects with PolicyError before creating a record or calling a provider when no channel is selectable', async () => {
      const env = newEnv();
      const kv = env.MESSAGES_KV as ReturnType<typeof memoryKV>;
      const { wa, sms, email, set } = threeProviders();
      const messaging = api.createMessaging(env, {
        templates,
        providers: () => set,
        // smsOnly defines only sms; neither part names it.
        delivery: { fallback: ['whatsapp'], always: ['email'] },
      });

      const error = await rejection(
        messaging.send({ template: 'smsOnly', to: TO, locale: 'en', input: { body: 'x' } })
      );
      expect(error).toBeInstanceOf(PolicyError);
      expect((error as PolicyError).templateName).toBe('smsOnly');

      expect(wa.calls).toHaveLength(0);
      expect(sms.calls).toHaveLength(0);
      expect(email.calls).toHaveLength(0);
      expect(kv.dump().keys().filter((k) => k.startsWith('msg:')).toArray()).toHaveLength(0);
    });
  });

  describe('validation before any provider call', () => {
    it('rejects a non-E.164 `to` without calling any provider', async () => {
      const wa = recordingProvider<RenderedWhatsApp>('whatsapp', 'rec-wa');
      const sms = recordingProvider<RenderedSms>('sms', 'rec-sms');
      const email = recordingProvider<RenderedEmail>('email', 'rec-email');

      const messaging = api.createMessaging(newEnv(), {
        templates,
        providers: () => ({ whatsapp: wa, sms, email }),
        delivery: { fallback: ['whatsapp', 'sms'], always: ['email'] },
      });

      const invalidNumbers = [
        '0771234567',
        '+0123456789',
        '14155550123',
        '+1 415 555 0123',
        '',
        '+1234567890123456', // 16 digits after '+': exceeds the E.164 15-digit ceiling
        '+1415555abc', // non-digit after a valid prefix
      ];
      for (const to of invalidNumbers) {
        const error = await rejection(
          messaging.send({ template: 'orderUpdate', to, locale: 'en', input: INPUT })
        );
        expect(error).toBeInstanceOf(Error);
        // A typed error: its own name, distinguishable from a template input failure.
        expect((error as Error).name).not.toBe('Error');
        expect(error).not.toBeInstanceOf(TemplateValidationError);
      }

      expect(wa.calls).toHaveLength(0);
      expect(sms.calls).toHaveLength(0);
      expect(email.calls).toHaveLength(0);
    });

    it('accepts E.164 numbers at the minimum and maximum length', async () => {
      const wa = recordingProvider<RenderedWhatsApp>('whatsapp', 'rec-wa');
      const messaging = api.createMessaging(newEnv(), {
        templates,
        providers: () => ({ whatsapp: wa }),
        delivery: { fallback: ['whatsapp'], always: [] },
      });

      const validNumbers = ['+12', '+123456789012345']; // 2 digits (minimum), 15 digits (maximum)
      for (const to of validNumbers) {
        const error = await rejection(
          messaging.send({ template: 'orderUpdate', to, locale: 'en', input: INPUT })
        );
        expect(error).toBeUndefined();
      }

      expect(wa.calls.map((c) => c.to)).toEqual(validNumbers);
    });

    it('rejects input failing the template schema without calling any provider', async () => {
      const wa = recordingProvider<RenderedWhatsApp>('whatsapp', 'rec-wa');
      const sms = recordingProvider<RenderedSms>('sms', 'rec-sms');
      const email = recordingProvider<RenderedEmail>('email', 'rec-email');

      const messaging = api.createMessaging(newEnv(), {
        templates,
        providers: () => ({ whatsapp: wa, sms, email }),
        delivery: { fallback: ['whatsapp', 'sms'], always: ['email'] },
      });

      const wrongType = await rejection(
        messaging.send({
          template: 'orderUpdate',
          to: TO,
          locale: 'en',
          input: { name: 42, orderId: 'A-100' },
        })
      );
      expect(wrongType).toBeInstanceOf(TemplateValidationError);
      expect((wrongType as Error).name).toBe('TemplateValidationError');

      const missingField = await rejection(
        messaging.send({ template: 'orderUpdate', to: TO, locale: 'en', input: { name: 'Ann' } })
      );
      expect(missingField).toBeInstanceOf(TemplateValidationError);

      expect(wa.calls).toHaveLength(0);
      expect(sms.calls).toHaveLength(0);
      expect(email.calls).toHaveLength(0);
    });
  });

  describe('retryable failures', () => {
    it('retries a retryable failure exactly once and records failed when the retry also fails', async () => {
      const sms = recordingProvider<RenderedSms>('sms', 'flaky-sms', [
        { ok: false, error: 'rate limited', retryable: true },
        { ok: false, error: 'rate limited again', retryable: true },
      ]);

      const events: StatusCallbackEvent[] = [];
      const messaging = api.createMessaging(newEnv(), {
        templates,
        providers: () => ({ sms }),
        delivery: { fallback: [], always: ['sms'] },
        onStatus: (event) => {
          events.push(event);
        },
      });

      const { id } = await messaging.send({
        template: 'smsOnly',
        to: TO,
        locale: 'en',
        input: { body: 'hello' },
      });

      // Original call plus exactly one retry; a second retryable failure is not retried again.
      expect(sms.calls).toHaveLength(2);
      expect(sms.calls[0].text).toBe('hello');
      expect(sms.calls[1].text).toBe('hello');

      const record = await messaging.status(id);
      expect(record).not.toBeNull();
      const smsAttempts = record!.always.filter((a) => a.channel === 'sms');
      expect(smsAttempts).toHaveLength(1);
      expect(smsAttempts[0]).toMatchObject({
        provider: 'flaky-sms',
        status: 'failed',
        error: 'rate limited again',
      });
      expect(record!.status).toBe('failed');

      // onStatus fires once per settled result, not once per retry attempt.
      expect(events).toEqual([{ id, channel: 'sms', provider: 'flaky-sms', status: 'failed' }]);
    });

    it('records sent when the single retry succeeds', async () => {
      const sms = recordingProvider<RenderedSms>('sms', 'flaky-sms', [
        { ok: false, error: 'transient', retryable: true },
        { ok: true, providerId: 'sms-retry-ok' },
      ]);

      const events: StatusCallbackEvent[] = [];
      const messaging = api.createMessaging(newEnv(), {
        templates,
        providers: () => ({ sms }),
        delivery: { fallback: [], always: ['sms'] },
        onStatus: (event) => {
          events.push(event);
        },
      });

      const { id } = await messaging.send({
        template: 'smsOnly',
        to: TO,
        locale: 'en',
        input: { body: 'hello' },
      });

      expect(sms.calls).toHaveLength(2);

      const record = await messaging.status(id);
      expect(record).not.toBeNull();
      expect(record!.always).toHaveLength(1);
      expect(record!.always[0]).toMatchObject({
        channel: 'sms',
        provider: 'flaky-sms',
        providerId: 'sms-retry-ok',
        status: 'sent',
      });
      expect(record!.status).toBe('sent');
      expect(events).toEqual([{ id, channel: 'sms', provider: 'flaky-sms', status: 'sent' }]);
    });

    it('retries a retryable failure exactly once on the fallback chain path too', async () => {
      const sms = recordingProvider<RenderedSms>('sms', 'flaky-sms', [
        { ok: false, error: 'rate limited', retryable: true },
        { ok: false, error: 'rate limited again', retryable: true },
      ]);

      const events: StatusCallbackEvent[] = [];
      const messaging = api.createMessaging(newEnv(), {
        templates,
        providers: () => ({ sms }),
        delivery: { fallback: ['sms'], always: [] },
        onStatus: (event) => {
          events.push(event);
        },
      });

      const { id } = await messaging.send({
        template: 'smsOnly',
        to: TO,
        locale: 'en',
        input: { body: 'hello' },
      });

      // Initial call plus exactly one retry on the chain channel.
      expect(sms.calls).toHaveLength(2);

      const record = await messaging.status(id);
      expect(record).not.toBeNull();
      const smsAttempts = record!.chain.attempts.filter((a) => a.channel === 'sms');
      expect(smsAttempts).toHaveLength(1);
      expect(smsAttempts[0]).toMatchObject({
        provider: 'flaky-sms',
        status: 'failed',
        error: 'rate limited again',
      });
      expect(record!.always).toHaveLength(0);
      // The chain is exhausted: chain and overall status are failed.
      expect(record!.chain.status).toBe('failed');
      expect(record!.status).toBe('failed');
      expect(events).toEqual([{ id, channel: 'sms', provider: 'flaky-sms', status: 'failed' }]);
    });

    it('does not retry a failure that is not retryable', async () => {
      const sms = recordingProvider<RenderedSms>('sms', 'dead-sms', [
        { ok: false, error: 'invalid destination' },
      ]);

      const messaging = api.createMessaging(newEnv(), {
        templates,
        providers: () => ({ sms }),
        delivery: { fallback: [], always: ['sms'] },
      });

      const { id } = await messaging.send({
        template: 'smsOnly',
        to: TO,
        locale: 'en',
        input: { body: 'hello' },
      });

      expect(sms.calls).toHaveLength(1);

      const record = await messaging.status(id);
      expect(record).not.toBeNull();
      expect(record!.always).toHaveLength(1);
      expect(record!.always[0]).toMatchObject({
        channel: 'sms',
        provider: 'dead-sms',
        status: 'failed',
        error: 'invalid destination',
      });
    });
  });

  describe('provider errors are settled, not propagated', () => {
    it('records a failed attempt when a provider rejects and still resolves send() with an id', async () => {
      let calls = 0;
      const sms = {
        name: 'broken-sms',
        channel: 'sms' as const,
        send: (): Promise<never> => {
          calls += 1;
          return Promise.reject(new Error('socket hang up'));
        },
      };

      const messaging = api.createMessaging(newEnv(), {
        templates,
        providers: () => ({ sms }),
        delivery: { fallback: [], always: ['sms'] },
      });

      const result = await messaging.send({
        template: 'smsOnly',
        to: TO,
        locale: 'en',
        input: { body: 'hello' },
      });

      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(0);
      expect(calls).toBe(1);

      const record = await messaging.status(result.id);
      expect(record).not.toBeNull();
      expect(record!.always).toHaveLength(1);
      expect(record!.always[0]).toMatchObject({
        channel: 'sms',
        provider: 'broken-sms',
        status: 'failed',
      });
      expect(record!.always[0].error).toContain('socket hang up');
    });

  });

  describe('chain and always run in parallel', () => {
    it('calls the first chain provider and the always provider before either has settled', async () => {
      const wa = gatedProvider<RenderedWhatsApp>('whatsapp', 'gated-wa', 'wa-pid');
      const email = gatedProvider<RenderedEmail>('email', 'gated-email', 'email-pid');

      const messaging = api.createMessaging(newEnv(), {
        templates,
        providers: () => ({ whatsapp: wa.provider, email: email.provider }),
        delivery: { fallback: ['whatsapp', 'sms'], always: ['email'] },
      });

      const pending = messaging.send({
        template: 'orderUpdate',
        to: TO,
        locale: 'en',
        input: INPUT,
      });

      // Both providers must have been invoked while both are still held open.
      await waitFor(() => wa.calls.length === 1 && email.calls.length === 1);
      expect(wa.calls).toHaveLength(1);
      expect(email.calls).toHaveLength(1);

      wa.release();
      email.release();
      const { id } = await pending;

      const record = await messaging.status(id);
      expect(record).not.toBeNull();
      expect(record!.chain.attempts[0]).toMatchObject({ channel: 'whatsapp', status: 'sent' });
      expect(record!.always[0]).toMatchObject({ channel: 'email', status: 'sent' });
    });
  });

  describe('kv option', () => {
    it('stores the record in options.kv rather than env.MESSAGES_KV when given', async () => {
      const envKv = memoryKV();
      const optionKv = memoryKV();
      const sms = recordingProvider<RenderedSms>('sms', 'rec-sms');

      const messaging = api.createMessaging(
        { MESSAGES_KV: envKv },
        {
          templates,
          providers: () => ({ sms }),
          delivery: { fallback: ['sms'], always: [] },
          kv: optionKv,
        }
      );

      const { id } = await messaging.send({
        template: 'smsOnly',
        to: TO,
        locale: 'en',
        input: { body: 'hello' },
      });

      expect(optionKv.dump().has(`msg:${id}`)).toBe(true);
      expect(envKv.dump().has(`msg:${id}`)).toBe(false);

      const record = await messaging.status(id);
      expect(record).not.toBeNull();
      expect(record!.id).toBe(id);
    });
  });

  describe('provider-id index', () => {
    it('indexes each attempt providerId back to { id, channel, provider }', async () => {
      const env = newEnv();
      const wa = recordingProvider<RenderedWhatsApp>('whatsapp', 'rec-wa', [
        { ok: true, providerId: 'wa-pid-1' },
      ]);
      const email = recordingProvider<RenderedEmail>('email', 'rec-email', [
        { ok: true, providerId: 'email-pid-1' },
      ]);

      const messaging = api.createMessaging(env, {
        templates,
        providers: () => ({ whatsapp: wa, email }),
        delivery: { fallback: ['whatsapp', 'sms'], always: ['email'] },
      });

      const { id } = await messaging.send({
        template: 'orderUpdate',
        to: TO,
        locale: 'en',
        input: INPUT,
      });

      const store = kvStatusStore(env.MESSAGES_KV!);
      expect(await store.lookupProviderId('wa-pid-1')).toEqual({
        id,
        channel: 'whatsapp',
        provider: 'rec-wa',
      });
      expect(await store.lookupProviderId('email-pid-1')).toEqual({
        id,
        channel: 'email',
        provider: 'rec-email',
      });
    });
  });

  describe('otp sends and ExecutionContext', () => {
    it('with ctx: resolves { id } after the record is created and runs delivery under ctx.waitUntil', async () => {
      const env = newEnv();
      const gated = gatedProvider<RenderedSms>('sms', 'otp-sms', 'otp-pid');
      const ctx = testContext();

      const messaging = api.createMessaging(env, {
        templates,
        providers: () => ({ sms: gated.provider }),
        delivery: { fallback: ['sms'], always: [] },
      });

      // The provider never completes until released, so send() can only resolve here
      // if delivery was deferred to ctx.waitUntil.
      const { id } = await messaging.send(
        { template: 'loginCode', to: TO, locale: 'en', input: { code: '123456' } },
        ctx
      );

      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      expect(ctx.promises.length).toBeGreaterThan(0);

      // Step 4 has happened: the record exists, pending, with no attempts yet.
      const before = await messaging.status(id);
      expect(before).not.toBeNull();
      expect(before!.kind).toBe('otp');
      expect(before!.chain.attempts).toHaveLength(0);
      expect(before!.status).toBe('pending');

      // The waitUntil work performs steps 5-8.
      gated.release();
      await Promise.all(ctx.promises);

      expect(gated.calls).toHaveLength(1);
      expect(gated.calls[0]).toMatchObject({
        text: 'Your code is 123456',
        to: TO,
        messageId: id,
        template: 'loginCode',
        kind: 'otp',
        locale: 'en',
      });

      const after = await messaging.status(id);
      expect(after!.chain.attempts).toHaveLength(1);
      expect(after!.chain.attempts[0]).toMatchObject({
        channel: 'sms',
        provider: 'otp-sms',
        providerId: 'otp-pid',
        status: 'sent',
      });
      expect(await kvStatusStore(env.MESSAGES_KV!).lookupProviderId('otp-pid')).toEqual({
        id,
        channel: 'sms',
        provider: 'otp-sms',
      });
    });

    it('a notification send with ctx present still runs delivery inline', async () => {
      const ctx = testContext();
      const wa = recordingProvider<RenderedWhatsApp>('whatsapp', 'rec-wa', [
        { ok: true, providerId: 'wa-inline' },
      ]);

      const messaging = api.createMessaging(newEnv(), {
        templates,
        providers: () => ({ whatsapp: wa }),
        delivery: { fallback: ['whatsapp'], always: [] },
      });

      const { id } = await messaging.send(
        { template: 'orderUpdate', to: TO, locale: 'en', input: INPUT },
        ctx
      );

      // The attempt is already recorded when send() resolves: delivery ran inline.
      expect(wa.calls).toHaveLength(1);
      const record = await messaging.status(id);
      expect(record).not.toBeNull();
      expect(record!.kind).toBe('notification');
      expect(record!.chain.attempts).toHaveLength(1);
      expect(record!.chain.attempts[0]).toMatchObject({
        channel: 'whatsapp',
        provider: 'rec-wa',
        providerId: 'wa-inline',
        status: 'sent',
      });
    });

    it('without ctx: runs delivery inline so the attempt is recorded before send() resolves', async () => {
      const calls: (RenderedSms & OutboundMeta)[] = [];
      const slowSms = {
        name: 'otp-sms',
        channel: 'sms' as const,
        send: async (message: RenderedSms & OutboundMeta): Promise<SendResult> => {
          calls.push(message);
          // A real delay: the attempt can only be on the record if the pipeline awaited us.
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { ok: true, providerId: 'otp-pid-inline' };
        },
      };

      const messaging = api.createMessaging(newEnv(), {
        templates,
        providers: () => ({ sms: slowSms }),
        delivery: { fallback: ['sms'], always: [] },
      });

      const { id } = await messaging.send({
        template: 'loginCode',
        to: TO,
        locale: 'en',
        input: { code: '123456' },
      });

      // Nothing else is awaited: the attempt must already be on the record.
      expect(calls).toHaveLength(1);
      const record = await messaging.status(id);
      expect(record).not.toBeNull();
      expect(record!.kind).toBe('otp');
      expect(record!.chain.attempts).toHaveLength(1);
      expect(record!.chain.attempts[0]).toMatchObject({
        channel: 'sms',
        provider: 'otp-sms',
        providerId: 'otp-pid-inline',
        status: 'sent',
      });
    });
  });

  describe('per-env provider memoisation', () => {
    it('builds providers once for two createMessaging calls with the same env', async () => {
      const env = newEnv();
      let builds = 0;
      const providers = (): ProviderSet => {
        builds += 1;
        return { sms: recordingProvider<RenderedSms>('sms', 'rec-sms') };
      };

      const a = api.createMessaging(env, {
        templates,
        providers,
        delivery: { fallback: ['sms'], always: [] },
      });
      const b = api.createMessaging(env, {
        templates,
        providers,
        delivery: { fallback: ['sms'], always: [] },
      });

      await a.send({ template: 'smsOnly', to: TO, locale: 'en', input: { body: 'one' } });
      await b.send({ template: 'smsOnly', to: TO, locale: 'en', input: { body: 'two' } });

      expect(builds).toBe(1);
    });

    it('builds providers again for a different env object', async () => {
      let builds = 0;
      const built: RecordingProvider<RenderedSms>[] = [];
      const providers = (): ProviderSet => {
        builds += 1;
        const sms = recordingProvider<RenderedSms>('sms', 'rec-sms');
        built.push(sms);
        return { sms };
      };

      const a = api.createMessaging(newEnv(), {
        templates,
        providers,
        delivery: { fallback: ['sms'], always: [] },
      });
      const b = api.createMessaging(newEnv(), {
        templates,
        providers,
        delivery: { fallback: ['sms'], always: [] },
      });

      await a.send({ template: 'smsOnly', to: TO, locale: 'en', input: { body: 'one' } });
      await b.send({ template: 'smsOnly', to: TO, locale: 'en', input: { body: 'two' } });

      expect(builds).toBe(2);
      // Each env's own provider set handled its own send.
      expect(built).toHaveLength(2);
      expect(built[0].calls.map((c) => c.text)).toEqual(['one']);
      expect(built[1].calls.map((c) => c.text)).toEqual(['two']);
    });
  });
});
