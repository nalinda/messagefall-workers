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
