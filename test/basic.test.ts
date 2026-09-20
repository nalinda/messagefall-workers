/**
 * Basic tests for messagefall-workers.
 *
 * These tests verify the core functionality works as expected.
 */

import { describe, expect, it } from 'bun:test';

import { createMessaging, defineTemplates, type Provider, type RenderedSms } from '../src/index.js';
import { newEnv, pingTemplates as templates } from './helpers/messaging.js';

function stubSms(name: string): Provider<RenderedSms> {
  return { name, channel: 'sms', send: () => Promise.resolve({ ok: true }) };
}

describe('createMessaging', () => {
  it('creates a messaging instance with send and status', () => {
    const messaging = createMessaging(newEnv(), {
      templates,
      providers: () => ({ sms: stubSms('stub') }),
    });

    expect(messaging).toBeDefined();
    expect(typeof messaging.send).toBe('function');
    expect(typeof messaging.status).toBe('function');
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
