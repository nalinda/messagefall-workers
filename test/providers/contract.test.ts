/**
 * Type-level tests for Provider contract (Issue #18).
 *
 * Acceptance criterion:
 * - An object literal implementing `Provider<RenderedSms>` with no import of the
 *   console provider is assignable to the `sms` slot of the `providers` option.
 */

import { describe, expect, it } from 'bun:test';

import { createMessaging } from '../../src/index.js';
import { newEnv, pingTemplates as templates } from '../helpers/messaging.js';
import type {
  DeliveryStatus,
  OutboundMeta,
  Provider,
  RenderedEmail,
  RenderedSms,
  RenderedWhatsApp,
  SendResult,
  StatusEvent,
} from './types.js';

// Type-level assertion helpers
type Extends<A, B> = A extends B ? true : false;
type Expect<T extends true> = T;

function assertType<T>(_value: T): void {
  // Compile-time type verification helper
}

describe('Provider contract type-level specification', () => {
  it('allows an object literal implementing Provider<RenderedSms> to be assigned to the sms provider slot without console provider import', () => {
    // Implement custom SMS provider without importing console provider
    const customSmsProvider: Provider<RenderedSms> = {
      name: 'my-custom-sms',
      channel: 'sms',
      send: async (message: RenderedSms & OutboundMeta): Promise<SendResult> => {
        await Promise.resolve();
        if (!message.to.startsWith('+')) {
          return { ok: false, error: 'Invalid phone number format', retryable: false };
        }
        return { ok: true, providerId: `gw_${message.messageId}` };
      },
      webhook: {
        parse: async (request: Request): Promise<StatusEvent[]> => {
          const body = (await request.json()) as { id: string; status: DeliveryStatus };
          return [
            {
              providerId: body.id,
              status: body.status,
              at: new Date().toISOString(),
            },
          ];
        },
      },
    };

    // Verify assignability to providers config slot
    type ProvidersFunction = (env: Record<string, unknown>) => {
      whatsapp?: Provider<RenderedWhatsApp>;
      sms?: Provider<RenderedSms>;
      email?: Provider<RenderedEmail>;
    };

    const providersFactory: ProvidersFunction = () => ({
      sms: customSmsProvider,
    });

    expect(customSmsProvider.name).toBe('my-custom-sms');
    expect(customSmsProvider.channel).toBe('sms');
    expect(typeof customSmsProvider.send).toBe('function');
    expect(providersFactory).toBeDefined();

    // Type assertion checks
    type TestAssignableToSmsSlot = Expect<
      Extends<typeof customSmsProvider, Provider<RenderedSms>>
    >;
    assertType<TestAssignableToSmsSlot>(true);

    // Runtime assertion: Register custom SMS provider with createMessaging
    const messaging = createMessaging(newEnv(), { templates, providers: providersFactory });
    expect(typeof messaging.send).toBe('function');
  });

  it('allows Provider<RenderedWhatsApp> and Provider<RenderedEmail> in their respective slots', () => {
    const customWhatsAppProvider: Provider<RenderedWhatsApp> = {
      name: 'meta-whatsapp-direct',
      channel: 'whatsapp',
      send: async (_message: RenderedWhatsApp & OutboundMeta): Promise<SendResult> => {
        await Promise.resolve();
        return {
          ok: true,
          providerId: 'wamid.12345',
        };
      },
      webhook: {
        verify: async (req: Request) => {
          await Promise.resolve();
          const url = new URL(req.url);
          return url.searchParams.get('hub.mode') === 'subscribe'
            ? new Response(url.searchParams.get('hub.challenge') ?? '')
            : null;
        },
        parse: async () => {
          await Promise.resolve();
          return [];
        },
      },
    };

    const customEmailProvider: Provider<RenderedEmail> = {
      name: 'direct-smtp-email',
      channel: 'email',
      send: async (_message: RenderedEmail & OutboundMeta): Promise<SendResult> => {
        await Promise.resolve();
        return {
          ok: true,
          providerId: 'email_msg_123',
        };
      },
    };

    const providersFactory = () => ({
      whatsapp: customWhatsAppProvider,
      email: customEmailProvider,
    });

    expect(customWhatsAppProvider.channel).toBe('whatsapp');
    expect(customEmailProvider.channel).toBe('email');
    expect(providersFactory).toBeDefined();

    type TestWaAssignable = Expect<
      Extends<typeof customWhatsAppProvider, Provider<RenderedWhatsApp>>
    >;
    type TestEmailAssignable = Expect<
      Extends<typeof customEmailProvider, Provider<RenderedEmail>>
    >;

    assertType<TestWaAssignable>(true);
    assertType<TestEmailAssignable>(true);

    // Runtime assertion: Register custom WhatsApp & Email providers with createMessaging
    const messaging = createMessaging(newEnv(), { templates, providers: providersFactory });
    expect(typeof messaging.send).toBe('function');
  });

  it('verifies SendResult discriminant shape and StatusEvent fields', () => {
    const successResult: SendResult = { ok: true, providerId: 'id_123' };
    const failureResult: SendResult = { ok: false, error: 'Rate limit exceeded', retryable: true };

    const statusEvent: StatusEvent = {
      providerId: 'id_123',
      status: 'delivered',
      error: undefined,
      at: '2026-09-20T12:00:00.000Z',
    };

    expect(successResult.ok).toBe(true);
    expect(failureResult.ok).toBe(false);
    expect(statusEvent.status).toBe('delivered');

    type TestSuccess = Expect<Extends<typeof successResult, SendResult>>;
    type TestFailure = Expect<Extends<typeof failureResult, SendResult>>;
    type TestStatusEvent = Expect<Extends<typeof statusEvent, StatusEvent>>;

    assertType<TestSuccess>(true);
    assertType<TestFailure>(true);
    assertType<TestStatusEvent>(true);
  });
});
