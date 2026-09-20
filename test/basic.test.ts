/**
 * Basic tests for messagefall-workers.
 *
 * These tests verify the core functionality works as expected.
 */

import { describe, expect, it } from 'bun:test';

import { createMessaging, defineTemplates, type Provider, type RenderedSms } from '../src/index.js';
import { newEnv, pingTemplates as templates } from './helpers/messaging.js';

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

describe('defineTemplates', () => {
  it('returns the defined template catalog', () => {
    const templates = defineTemplates({
      otp: {
        kind: 'otp',
        whatsapp: {
          template: 'otp_template',
          language: 'en',
          params: ({ code }: { code: string }) => [code],
        },
        sms: ({ code }: { code: string }) => `Your code is ${code}`,
      },
      notification: {
        kind: 'notification',
        sms: () => 'Notification message',
      },
    });

    expect(templates).toBeDefined();
    expect(templates.otp.kind).toBe('otp');
    expect(templates.notification.kind).toBe('notification');
  });
});
