/**
 * Tests for createMessaging: provider wiring, sends and status.
 */

import type { DurableObjectNamespace } from '@cloudflare/workers-types';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  registeredMessagingOptions,
  registerMessagingOptions,
  resetMessagingOptions,
} from '../../src/core/timer.js';
import {
  createMessaging,
  defineTemplates,
  type Provider,
  type RenderedEmail,
  type RenderedSms,
  type RenderedWhatsApp,
  type StatusEvent,
} from '../../src/index.js';
import { consoleProvider } from '../../src/providers/console/index.js';
import { createMockFallbackTimer } from '../helpers/fallback.js';
import {
  captureConsole,
  memoryKV,
  newEnv,
  pingTemplates as templates,
  waitFor,
} from '../helpers/messaging.js';

function stubSms(name: string): Provider<RenderedSms> & { calls: number } {
  const provider = {
    name,
    channel: 'sms' as const,
    calls: 0,
    send: () => {
      provider.calls += 1;
      return Promise.resolve({ ok: true as const, providerId: `${name}-1` });
    },
  };
  return provider;
}

/**
 * A provider whose webhook replays whatever events the test has queued, so a test can drive the
 * exact vendor callback ordering it needs.
 */
function queueingProvider<R>(
  name: string,
  channel: 'whatsapp' | 'sms' | 'email'
): Provider<R> & { queue: StatusEvent[]; calls: number } {
  const provider = {
    name,
    channel,
    queue: [] as StatusEvent[],
    calls: 0,
    send: () => {
      provider.calls += 1;
      return Promise.resolve({ ok: true as const, providerId: `${name}-1` });
    },
    webhook: {
      parse: (): Promise<StatusEvent[]> => {
        const events = [...provider.queue];
        provider.queue.length = 0;
        return Promise.resolve(events);
      },
    },
  };
  return provider;
}

describe('createMessaging', () => {
  it('sends through the registered provider and exposes the record via status', async () => {
    const stub = stubSms('stub');
    const messaging = createMessaging(newEnv(), {
      templates,
      providers: () => ({ sms: stub }),
    });

    const { id } = await messaging.send({
      template: 'ping',
      to: '+14155550123',
      locale: 'en',
      input: undefined,
    });

    expect(stub.calls).toBe(1);
    const record = await messaging.status(id);
    expect(record!.chain.attempts[0]).toMatchObject({
      provider: 'stub',
      providerId: 'stub-1',
      status: 'sent',
    });
  });
});

describe('createMessaging.handleWebhook', () => {
  it('routes a provider status webhook to the record and reports it through onStatus', async () => {
    const provider: Provider<RenderedSms> = {
      name: 'hooked-sms',
      channel: 'sms',
      send: () => Promise.resolve({ ok: true, providerId: 'hooked-1' }),
      webhook: {
        parse: async (request) => {
          const body = (await request.json()) as { id: string; status: 'delivered' };
          return [{ providerId: body.id, status: body.status, at: '2026-09-20T00:00:00.000Z' }];
        },
      },
    };
    const events: unknown[] = [];
    const messaging = createMessaging(newEnv(), {
      templates,
      providers: () => ({ sms: provider }),
      onStatus: (event) => {
        events.push(event);
      },
    });

    const { id } = await messaging.send({
      template: 'ping',
      to: '+14155550123',
      locale: 'en',
      input: undefined,
    });
    const response = await messaging.handleWebhook(
      'hooked-sms',
      new Request('https://worker.local/webhooks/hooked-sms', {
        method: 'POST',
        body: JSON.stringify({ id: 'hooked-1', status: 'delivered' }),
      })
    );

    expect(response.status).toBe(200);
    const record = await messaging.status(id);
    expect(record!.chain.attempts[0]).toMatchObject({
      providerId: 'hooked-1',
      status: 'delivered',
    });
    expect(record!.status).toBe('delivered');
    expect(events).toEqual([
      { id, channel: 'sms', provider: 'hooked-sms', status: 'sent' },
      { id, channel: 'sms', provider: 'hooked-sms', status: 'delivered' },
    ]);
    const unknown = await messaging.handleWebhook('nope', new Request('https://worker.local/x'));
    expect(unknown.status).toBe(404);
  });
});

describe('createMessaging.handleWebhook observer failures', () => {
  it('logs a throwing onStatus per event, keeps applying the batch and still answers 200', async () => {
    const provider: Provider<RenderedSms> = {
      name: 'hooked-sms',
      channel: 'sms',
      send: () => Promise.resolve({ ok: true, providerId: 'hooked-2' }),
      webhook: {
        parse: () =>
          Promise.resolve([
            {
              providerId: 'hooked-2',
              status: 'delivered' as const,
              at: '2026-09-20T00:00:00.000Z',
            },
            { providerId: 'hooked-2', status: 'read' as const, at: '2026-09-20T00:00:01.000Z' },
          ]),
      },
    };
    const seen: string[] = [];
    const messaging = createMessaging(newEnv(), {
      templates,
      providers: () => ({ sms: provider }),
      onStatus: (event) => {
        seen.push(event.status);
        if (event.status === 'delivered') {
          throw new Error('observer exploded');
        }
      },
    });
    const captured = captureConsole(['warn']);

    try {
      const { id } = await messaging.send({
        template: 'ping',
        to: '+14155550123',
        locale: 'en',
        input: undefined,
      });
      const response = await messaging.handleWebhook(
        'hooked-sms',
        new Request('https://worker.local/webhooks/hooked-sms', { method: 'POST' })
      );

      expect(response.status).toBe(200);
      // Both events were applied and observed despite the first observer throwing.
      expect(seen).toEqual(['sent', 'delivered', 'read']);
      const record = await messaging.status(id);
      expect(record!.chain.attempts[0].status).toBe('read');
      expect(captured.logs.some((line) => line.includes(id))).toBe(true);
      // Distinct from the record-write and providerId-index failures, which used to share this
      // one's event name and left an operator unable to tell the three apart.
      expect(captured.logs.some((line) => line.includes('send.observer-failed'))).toBe(true);
    } finally {
      captured.restore();
    }
  });
});

describe('createMessaging simulated statuses', () => {
  // The console provider's `simulate` option fires statuses on `onSimulatedStatus`. The core
  // has to wire that hook to the very same handling a real webhook status gets, or the
  // README's local-development workflow silently drops every simulated status.
  const twoChannelTemplates = defineTemplates({
    ping: {
      input: z.unknown(),
      kind: 'notification',
      whatsapp: { text: () => 'ping' },
      sms: () => 'ping',
    },
  });

  it('applies a simulated delivered status to the record and reports it through onStatus', async () => {
    const provider = consoleProvider<RenderedSms>({
      channel: 'sms',
      name: 'console-sms',
      simulate: { status: 'delivered', afterMs: 1 },
    });
    const events: string[] = [];
    const messaging = createMessaging(newEnv(), {
      templates,
      providers: () => ({ sms: provider }),
      onStatus: (event) => {
        events.push(event.status);
      },
    });

    const { id } = await messaging.send({
      template: 'ping',
      to: '+14155550123',
      locale: 'en',
      input: undefined,
    });
    await waitFor(async () => {
      const current = await messaging.status(id);
      return current?.status === 'delivered';
    });

    const record = await messaging.status(id);
    expect(record!.chain.attempts[0]).toMatchObject({
      providerId: `console_${id}`,
      status: 'delivered',
    });
    expect(record!.status).toBe('delivered');
    expect(events).toEqual(['sent', 'delivered']);
  });

  it('drives fallback from a simulated failed status, exactly as a failed webhook would', async () => {
    const wa = consoleProvider<RenderedWhatsApp>({
      channel: 'whatsapp',
      name: 'console-whatsapp',
      simulate: { status: 'failed', afterMs: 1 },
    });
    const sms = consoleProvider<RenderedSms>({ channel: 'sms', name: 'console-sms' });
    const messaging = createMessaging(newEnv(), {
      templates: twoChannelTemplates,
      providers: () => ({ whatsapp: wa, sms }),
      delivery: { fallback: ['whatsapp', 'sms'], always: [] },
    });

    const { id } = await messaging.send({
      template: 'ping',
      to: '+14155550123',
      locale: 'en',
      input: undefined,
    });
    await waitFor(async () => {
      const current = await messaging.status(id);
      return (current?.chain.attempts.length ?? 0) > 1;
    });

    const record = await messaging.status(id);
    expect(record!.chain.attempts.map((attempt) => attempt.channel)).toEqual(['whatsapp', 'sms']);
    expect(record!.chain.attempts[0].status).toBe('failed');
    expect(record!.chain.attempts[1]).toMatchObject({ provider: 'console-sms', status: 'sent' });
  });

  // Regression: the hook used to be assigned onto the provider objects themselves, which are
  // memoised per `env`. A second instance overwrote the first one's closure, so the first
  // instance's simulated statuses were reported to the second instance's observer instead.
  it('keeps two instances in one isolate from cross-wiring their simulated statuses', async () => {
    const env = newEnv();
    const provider = consoleProvider<RenderedSms>({
      channel: 'sms',
      name: 'console-sms',
      simulate: { status: 'delivered', afterMs: 1 },
    });

    const seenByFirst: string[] = [];
    const seenBySecond: string[] = [];
    const first = createMessaging(env, {
      templates,
      providers: () => ({ sms: provider }),
      onStatus: (event) => {
        seenByFirst.push(event.status);
      },
    });
    // Built after `first`, on the same env and so over the same memoised provider objects.
    createMessaging(env, {
      templates,
      providers: () => ({ sms: provider }),
      onStatus: (event) => {
        seenBySecond.push(event.status);
      },
    });

    const { id } = await first.send({
      template: 'ping',
      to: '+14155550123',
      locale: 'en',
      input: undefined,
    });
    await waitFor(async () => {
      const current = await first.status(id);
      return current?.status === 'delivered';
    });

    expect(seenByFirst).toEqual(['sent', 'delivered']);
    expect(seenBySecond).toEqual([]);
  });
});

describe('createMessaging.handleWebhook concurrency', () => {
  // A vendor redelivering a `failed` webhook used to have two callbacks read the same record,
  // both find the last chain attempt `failed` and both walk the chain — two attempts, and so two
  // real sends, on the next channel. For an OTP that is the same one-time code sent twice.
  it('advances the chain once when the same failed status is delivered twice concurrently', async () => {
    const otpTemplates = defineTemplates({
      loginCode: {
        input: z.object({ code: z.string() }),
        kind: 'otp',
        whatsapp: {
          template: 'auth_code',
          language: 'en',
          params: ({ code }: { code: string }) => [code],
        },
        sms: ({ code }: { code: string }) => `Your code is ${code}`,
      },
    });

    const failedAt = '2026-09-20T00:00:00.000Z';
    const whatsapp: Provider<RenderedWhatsApp> = {
      name: 'wa',
      channel: 'whatsapp',
      send: () => Promise.resolve({ ok: true, providerId: 'wa-dup-1' }),
      webhook: {
        parse: () =>
          Promise.resolve([
            {
              providerId: 'wa-dup-1',
              status: 'failed' as const,
              error: 'undeliverable',
              at: failedAt,
            },
          ]),
      },
    };
    const sms = stubSms('sms');

    const messaging = createMessaging(newEnv(), {
      templates: otpTemplates,
      providers: () => ({ whatsapp, sms }),
    });

    const { id } = await messaging.send({
      template: 'loginCode',
      to: '+14155550123',
      locale: 'en',
      input: { code: '123456' },
    });

    const deliver = (): Promise<Response> =>
      messaging.handleWebhook(
        'wa',
        new Request('https://worker.local/webhooks/wa', { method: 'POST' })
      );
    const [first, second] = await Promise.all([deliver(), deliver()]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // One advance, so one SMS send and one new attempt on the record.
    expect(sms.calls).toBe(1);
    const record = await messaging.status(id);
    expect(record!.chain.attempts).toHaveLength(2);
    expect(record!.chain.attempts.map((attempt) => attempt.channel)).toEqual(['whatsapp', 'sms']);
  });
});

describe('createMessaging late confirmation for a superseded channel', () => {
  // A `delivered` callback for a channel the chain has already fallen back past is real news
  // about that attempt (the webhook transition table accepts it as an upgrade), and it means the
  // message arrived. Two things used to go wrong once it landed: the chain's status was still
  // derived from the LAST attempt, so a delivered chain reported `sent` and then `failed`; and
  // the fallback bridge decided the chain was finished from the triggering EVENT's status rather
  // than from the record, so any terminal event released the timer and the `in:<id>` render
  // input regardless of what the chain as a whole said.
  it('reports the chain delivered and never falls back again after the later channel also fails', async () => {
    const otpTemplates = defineTemplates({
      loginCode: {
        input: z.object({ code: z.string() }),
        kind: 'otp',
        whatsapp: {
          template: 'auth_code',
          language: 'en',
          params: ({ code }: { code: string }) => [code],
        },
        sms: ({ code }: { code: string }) => `Your code is ${code}`,
        email: {
          subject: () => 'Your code',
          text: ({ code }: { code: string }) => `Your code is ${code}`,
        },
      },
    });

    const whatsapp = queueingProvider<RenderedWhatsApp>('wa', 'whatsapp');
    const sms = queueingProvider<RenderedSms>('sms', 'sms');
    const email = queueingProvider<RenderedEmail>('email', 'email');

    const kv = memoryKV();
    const timer = createMockFallbackTimer();
    const messaging = createMessaging(
      { MESSAGES_KV: kv },
      {
        templates: otpTemplates,
        providers: () => ({ whatsapp, sms, email }),
        delivery: { fallback: ['whatsapp', 'sms', 'email'], always: [] },
        // `resolveTimer` takes any object that is not a Durable Object namespace as the client
        // itself, which is how a test drives the arm/cancel seam without a real DO.
        timer: timer as unknown as DurableObjectNamespace,
      }
    );

    const { id } = await messaging.send({
      template: 'loginCode',
      to: '+14155550123',
      email: 'user@example.com',
      locale: 'en',
      input: { code: '123456' },
    });

    const deliver = (provider: string): Promise<Response> =>
      messaging.handleWebhook(
        provider,
        new Request(`https://worker.local/webhooks/${provider}`, { method: 'POST' })
      );

    // WhatsApp fails: the chain falls back to SMS, which is now genuinely in flight.
    whatsapp.queue.push({
      providerId: 'wa-1',
      status: 'failed',
      error: 'undeliverable',
      at: '2026-09-20T00:00:01.000Z',
    });
    await deliver('wa');
    expect(sms.calls).toBe(1);

    // WhatsApp's `delivered` finally arrives, for that same superseded attempt.
    whatsapp.queue.push({
      providerId: 'wa-1',
      status: 'delivered',
      at: '2026-09-20T00:00:02.000Z',
    });
    await deliver('wa');

    const afterUpgrade = await messaging.status(id);
    expect(afterUpgrade!.chain.attempts.map((attempt) => attempt.status)).toEqual([
      'delivered',
      'sent',
    ]);
    expect(afterUpgrade!.chain.status).toBe('delivered');
    expect(afterUpgrade!.status).toBe('delivered');

    // The seam this test exists for: delivery wins, so the chain is released *now* — at the exact
    // moment the SMS attempt is still `sent`, i.e. a later attempt is genuinely in flight. The
    // timer must be cancelled and the stored render input dropped, not held until the in-flight
    // attempt resolves. Asserting the chain reads `delivered` and email is never tried would pass
    // either way; only these two assertions fail if the release is deferred.
    expect(timer.isCancelled(id)).toBe(true);
    expect(await kv.get(`in:${id}`)).toBeNull();

    // The SMS attempt then fails. The message was already delivered, so the chain must not walk
    // on to email — and it must not report itself failed either.
    sms.queue.push({
      providerId: 'sms-1',
      status: 'failed',
      error: 'carrier rejected',
      at: '2026-09-20T00:00:03.000Z',
    });
    await deliver('sms');

    const final = await messaging.status(id);
    expect(email.calls).toBe(0);
    expect(final!.chain.attempts.map((attempt) => attempt.channel)).toEqual(['whatsapp', 'sms']);
    expect(final!.chain.status).toBe('delivered');
    expect(final!.status).toBe('delivered');
  });
});

describe('registerMessagingOptions', () => {
  // The registry is a module-level singleton the FallbackTimer's alarm reads its configuration
  // from, and it is last-call-wins. Overwriting it used to be silent, so a second
  // createMessaging with its own templates or providers quietly redirected every alarm in the
  // isolate to the wrong configuration.
  it('warns when a different options object replaces the registered one, and stays quiet otherwise', () => {
    const first = { templates, providers: () => ({ sms: stubSms('first') }) };
    const second = { templates, providers: () => ({ sms: stubSms('second') }) };
    resetMessagingOptions();
    const captured = captureConsole(['warn']);

    try {
      registerMessagingOptions(first);
      // What createMessaging does on every request: the same object, so nothing to say.
      registerMessagingOptions(first);
      expect(captured.logs.filter((line) => line.includes('timer.options-replaced'))).toHaveLength(
        0
      );

      registerMessagingOptions(second);
      expect(captured.logs.filter((line) => line.includes('timer.options-replaced'))).toHaveLength(
        1
      );
      expect(registeredMessagingOptions()).toBe(second);
    } finally {
      captured.restore();
      resetMessagingOptions();
    }
  });
});

describe('defineTemplates', () => {
  it('returns the defined template catalog', () => {
    const templates = defineTemplates({
      otp: {
        input: z.object({ code: z.string() }),
        kind: 'otp',
        whatsapp: {
          template: 'otp_template',
          language: 'en',
          params: ({ code }: { code: string }) => [code],
        },
        sms: ({ code }: { code: string }) => `Your code is ${code}`,
      },
      notification: {
        input: z.unknown(),
        kind: 'notification',
        sms: () => 'Notification message',
      },
    });

    expect(templates).toBeDefined();
    expect(templates.otp.kind).toBe('otp');
    expect(templates.notification.kind).toBe('notification');
  });
});
