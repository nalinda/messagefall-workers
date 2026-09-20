/**
 * Basic tests for messagefall-workers.
 *
 * These tests verify the core functionality works as expected.
 */

import { describe, expect, it } from 'bun:test';

import { createMessaging, defineTemplates } from '../src/index.js';
import { createMockKV } from './helpers/index.js';

describe('createMessaging', () => {
  it('creates a messaging state with stub provider', () => {
    const config = {
      kv: createMockKV(),
      providers: [
        {
          id: 'stub',
          config: {},
          state: { kv: {} },
        },
      ],
    };

    const state = createMessaging(config);

    expect(state).toBeDefined();
    expect(state.providers.size).toBe(1);
  });

  it('registers the stub provider', () => {
    const config = {
      kv: createMockKV(),
      providers: [
        {
          id: 'stub',
          config: {},
          state: { kv: {} },
        },
      ],
    };

    const state = createMessaging(config);
    const provider = state.providers.get('stub');

    expect(provider).toBeDefined();
    expect(provider?.id).toBe('stub');
    expect(provider?.channel).toBe('whatsapp');
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
