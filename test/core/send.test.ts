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

import { consoleProvider } from '../../src/providers/console/index.js';
import type { RenderedEmail, RenderedSms, RenderedWhatsApp } from '../../src/providers/types.js';
import { defineTemplates } from '../../src/templates.js';
import type { MessagingEnv } from '../../src/types.js';
import {
  loadMessagingApi,
  memoryKV,
  type MessagingApi,
  type ProviderSet,
  type RecordingProvider,
  recordingProvider,
  type StatusCallbackEvent,
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

        // The core must not log rendered content.
        const joined = silenced.logs.join('\n');
        expect(joined).not.toContain('has shipped');
        expect(joined).not.toContain('on its way');
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

      const invalidNumbers = ['0771234567', '+0123456789', '14155550123', '+1 415 555 0123', ''];
      for (const to of invalidNumbers) {
        const error = await rejection(
          messaging.send({ template: 'orderUpdate', to, locale: 'en', input: INPUT })
        );
        expect(error).toBeInstanceOf(Error);
      }

      expect(wa.calls).toHaveLength(0);
      expect(sms.calls).toHaveLength(0);
      expect(email.calls).toHaveLength(0);
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
      expect(wrongType).toBeInstanceOf(Error);

      const missingField = await rejection(
        messaging.send({ template: 'orderUpdate', to: TO, locale: 'en', input: { name: 'Ann' } })
      );
      expect(missingField).toBeInstanceOf(Error);

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
    });

    it('records sent when the single retry succeeds', async () => {
      const sms = recordingProvider<RenderedSms>('sms', 'flaky-sms', [
        { ok: false, error: 'transient', retryable: true },
        { ok: true, providerId: 'sms-retry-ok' },
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
