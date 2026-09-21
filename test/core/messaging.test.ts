/**
 * Tests for createMessaging: provider wiring, sends and status.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  createMessaging,
  defineTemplates,
  type Provider,
  type RenderedSms,
  type RenderedWhatsApp,
} from '../../src/index.js';
import { consoleProvider } from '../../src/providers/console/index.js';
import { captureConsole, newEnv, pingTemplates as templates, waitFor } from '../helpers/messaging.js';

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

describe('createMessaging', () => {
  it('sends through the registered provider and exposes the record via status', async () => {
    const stub = stubSms('stub');
    const messaging = createMessaging(newEnv(), {
      templates,
      providers: () => ({ sms: stub }),
    });

    const { id } = await messaging.send({ template: 'ping', to: '+14155550123', locale: 'en', input: undefined });

    expect(stub.calls).toBe(1);
    const record = await messaging.status(id);
    expect(record!.chain.attempts[0]).toMatchObject({ provider: 'stub', providerId: 'stub-1', status: 'sent' });
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

    const { id } = await messaging.send({ template: 'ping', to: '+14155550123', locale: 'en', input: undefined });
    const response = await messaging.handleWebhook(
      'hooked-sms',
      new Request('https://worker.local/webhooks/hooked-sms', {
        method: 'POST',
        body: JSON.stringify({ id: 'hooked-1', status: 'delivered' }),
      })
    );

    expect(response.status).toBe(200);
    const record = await messaging.status(id);
    expect(record!.chain.attempts[0]).toMatchObject({ providerId: 'hooked-1', status: 'delivered' });
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
            { providerId: 'hooked-2', status: 'delivered' as const, at: '2026-09-20T00:00:00.000Z' },
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
      const { id } = await messaging.send({ template: 'ping', to: '+14155550123', locale: 'en', input: undefined });
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
            { providerId: 'wa-dup-1', status: 'failed' as const, error: 'undeliverable', at: failedAt },
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
