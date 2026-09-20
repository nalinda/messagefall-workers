/**
 * Type-level specification tests for createMessagingClient and DeliveryOverrideFor (Issue #12).
 *
 * Acceptance criteria:
 * - Type-level tests: correct call compiles; wrong template name, wrong input field,
 *   and a delivery.always naming a channel the template does not define fail to compile.
 * - DeliveryOverrideFor<T, K> narrows fallback and always to the channels template K defines, or 'all'.
 * - Bun-test-executable file with real runtime expect() calls tied to actual behavior.
 */

import type { Fetcher } from '@cloudflare/workers-types';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { MessageRecord } from '../../src/core/status.js';
import type { InputOf } from '../../src/templates.js';
import { defineTemplates } from '../../src/templates.js';
import {
  type ClientSendResult,
  type CreateMessagingClientOptions,
  createMockFetcher,
  type DeliveryOverrideFor,
  loadCreateMessagingClient,
  type MessagingClient,
} from '../helpers/client.js';

// Type assertion helpers matching test/templates.type.test.ts
type Extends<A, B> = A extends B ? true : false;
type Not<T extends boolean> = T extends true ? false : true;
type Expect<T extends true> = T;
type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
  ? true
  : false;

function assertType<T>(_value: T): void {
  // Compile-time type verification helper
}

describe('createMessagingClient type-level specifications (Issue #12)', () => {
  const catalogDefs = {
    loginCode: {
      input: z.object({ code: z.string().length(6) }),
      kind: 'otp' as const,
      sms: ({ code }: { code: string }) => `Your code is ${code}`,
    },
    orderShipped: {
      input: z.object({ orderId: z.string(), trackingUrl: z.string() }),
      kind: 'notification' as const,
      whatsapp: {
        template: 'order_shipped',
        language: 'en',
        params: ({ orderId }: { orderId: string }) => [orderId],
      },
      email: {
        subject: ({ orderId }: { orderId: string }) => `Order ${orderId}`,
        text: ({ trackingUrl }: { trackingUrl: string }) => `Track at ${trackingUrl}`,
      },
    },
    multiChannel: {
      input: z.object({ alert: z.string() }),
      kind: 'notification' as const,
      whatsapp: {
        template: 'alert',
        language: 'en',
        params: ({ alert }: { alert: string }) => [alert],
      },
      sms: ({ alert }: { alert: string }) => alert,
      email: {
        subject: ({ alert }: { alert: string }) => alert,
        text: ({ alert }: { alert: string }) => alert,
      },
    },
  };

  const templates = defineTemplates(catalogDefs);
  type Catalog = typeof templates;

  it('verifies that a correctly typed send call compiles with exact input types', async () => {
    expect(templates).toBeDefined();

    // Type assertions for InputOf<Catalog, K>
    type LoginInput = InputOf<Catalog, 'loginCode'>;
    type OrderInput = InputOf<Catalog, 'orderShipped'>;

    type TestLoginInputExact = Expect<Equals<LoginInput, { code: string }>>;
    type TestOrderInputExact = Expect<Equals<OrderInput, { orderId: string; trackingUrl: string }>>;

    assertType<TestLoginInputExact>(true);
    assertType<TestOrderInputExact>(true);

    // Valid send argument types
    type ValidLoginSendArgs = {
      to: string;
      locale: string;
      input: { code: string };
      delivery?: DeliveryOverrideFor<Catalog, 'loginCode'>;
    };

    type TestValidSendType = Expect<
      Extends<ValidLoginSendArgs['input'], InputOf<Catalog, 'loginCode'>>
    >;
    assertType<TestValidSendType>(true);

    // Runtime assertion tied to client send
    const createMessagingClient = await loadCreateMessagingClient();
    const fetcher = createMockFetcher(() => {
      return Response.json({ id: 'msg_01J8TYPE001' }, { status: 200 });
    });

    const client = createMessagingClient<Catalog>({ binding: fetcher });
    const result = await client.send('loginCode', {
      to: '+94770000001',
      locale: 'en',
      input: { code: '123456' },
    });

    expect(result).toEqual({ ok: true, id: 'msg_01J8TYPE001' });
  });

  it('verifies that wrong template name is rejected at compile time', async () => {
    // Keyof check rejects unknown template names
    type UnknownTemplate = 'nonExistentTemplate';
    type TestUnknownTemplateRejected = Expect<Not<Extends<UnknownTemplate, keyof Catalog>>>;
    assertType<TestUnknownTemplateRejected>(true);

    // Runtime assertion
    const createMessagingClient = await loadCreateMessagingClient();
    const fetcher = createMockFetcher(() => {
      return Response.json({ error: 'Unknown template "nonExistentTemplate"' }, { status: 404 });
    });

    const client = createMessagingClient<Catalog>({ binding: fetcher });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await client.send('nonExistentTemplate' as any, {
      to: '+94770000001',
      locale: 'en',
      input: { code: '123456' },
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: 'Unknown template "nonExistentTemplate"',
    });
  });

  it('verifies that wrong input field or wrong type is rejected at compile time', async () => {
    // Missing required field
    type MissingFieldInput = { wrongKey: string };
    type TestMissingFieldRejected = Expect<
      Not<Extends<MissingFieldInput, InputOf<Catalog, 'loginCode'>>>
    >;
    assertType<TestMissingFieldRejected>(true);

    // Wrong field type (number instead of string)
    type WrongTypeInput = { code: number };
    type TestWrongTypeRejected = Expect<
      Not<Extends<WrongTypeInput, InputOf<Catalog, 'loginCode'>>>
    >;
    assertType<TestWrongTypeRejected>(true);

    // Runtime assertion
    const createMessagingClient = await loadCreateMessagingClient();
    const fetcher = createMockFetcher(() => {
      return Response.json(
        { error: 'Template input validation failed: code must be a string' },
        { status: 400 }
      );
    });

    const client = createMessagingClient<Catalog>({ binding: fetcher });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const invalidInput: any = { code: 123_456 };
    const result = await client.send('loginCode', {
      to: '+94770000001',
      locale: 'en',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      input: invalidInput,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'Template input validation failed: code must be a string',
    });
  });

  it('verifies DeliveryOverrideFor narrows delivery.always and delivery.fallback to template defined channels', async () => {
    // loginCode defines ONLY 'sms'
    type LoginDelivery = DeliveryOverrideFor<Catalog, 'loginCode'>;

    // Valid: delivery naming 'sms'
    type ValidSmsFallback = { fallback: ['sms'] };
    type ValidSmsAlways = { always: ['sms'] };
    type TestValidSmsFallback = Expect<Extends<ValidSmsFallback, LoginDelivery>>;
    type TestValidSmsAlways = Expect<Extends<ValidSmsAlways, LoginDelivery>>;
    assertType<TestValidSmsFallback>(true);
    assertType<TestValidSmsAlways>(true);

    // Invalid: delivery naming 'whatsapp' or 'email' on smsOnly template
    type BadWhatsappAlways = { always: ['whatsapp'] };
    type BadEmailAlways = { always: ['email'] };
    type BadWhatsappFallback = { fallback: ['whatsapp'] };
    type BadEmailFallback = { fallback: ['email'] };

    type TestBadWhatsappAlwaysRejected = Expect<Not<Extends<BadWhatsappAlways, LoginDelivery>>>;
    type TestBadEmailAlwaysRejected = Expect<Not<Extends<BadEmailAlways, LoginDelivery>>>;
    type TestBadWhatsappFallbackRejected = Expect<Not<Extends<BadWhatsappFallback, LoginDelivery>>>;
    type TestBadEmailFallbackRejected = Expect<Not<Extends<BadEmailFallback, LoginDelivery>>>;

    assertType<TestBadWhatsappAlwaysRejected>(true);
    assertType<TestBadEmailAlwaysRejected>(true);
    assertType<TestBadWhatsappFallbackRejected>(true);
    assertType<TestBadEmailFallbackRejected>(true);

    // orderShipped defines 'whatsapp' and 'email' (NOT 'sms')
    type OrderDelivery = DeliveryOverrideFor<Catalog, 'orderShipped'>;
    type ValidOrderDelivery = { fallback: ['whatsapp']; always: ['email'] };
    type TestValidOrderDelivery = Expect<Extends<ValidOrderDelivery, OrderDelivery>>;
    assertType<TestValidOrderDelivery>(true);

    type BadOrderSmsAlways = { always: ['sms'] };
    type BadOrderSmsFallback = { fallback: ['sms'] };
    type TestBadOrderSmsAlwaysRejected = Expect<Not<Extends<BadOrderSmsAlways, OrderDelivery>>>;
    type TestBadOrderSmsFallbackRejected = Expect<Not<Extends<BadOrderSmsFallback, OrderDelivery>>>;

    assertType<TestBadOrderSmsAlwaysRejected>(true);
    assertType<TestBadOrderSmsFallbackRejected>(true);

    // Runtime assertion
    const createMessagingClient = await loadCreateMessagingClient();
    const fetcher = createMockFetcher(() => {
      return Response.json({ id: 'msg_01J8OVERRIDE001' }, { status: 200 });
    });

    const client = createMessagingClient<Catalog>({ binding: fetcher });
    const result = await client.send('orderShipped', {
      to: '+94770000001',
      email: 'user@example.com',
      locale: 'en',
      input: { orderId: 'ord_100', trackingUrl: 'https://example.com/t/100' },
      delivery: {
        fallback: ['whatsapp'],
        always: ['email'],
      },
    });

    expect(result).toEqual({ ok: true, id: 'msg_01J8OVERRIDE001' });
  });

  it('verifies delivery: "all" is valid for any template', async () => {
    type LoginDelivery = DeliveryOverrideFor<Catalog, 'loginCode'>;
    type OrderDelivery = DeliveryOverrideFor<Catalog, 'orderShipped'>;
    type MultiDelivery = DeliveryOverrideFor<Catalog, 'multiChannel'>;

    type TestLoginAll = Expect<Extends<'all', LoginDelivery>>;
    type TestOrderAll = Expect<Extends<'all', OrderDelivery>>;
    type TestMultiAll = Expect<Extends<'all', MultiDelivery>>;

    assertType<TestLoginAll>(true);
    assertType<TestOrderAll>(true);
    assertType<TestMultiAll>(true);

    // Runtime assertion
    const createMessagingClient = await loadCreateMessagingClient();
    const fetcher = createMockFetcher(() => {
      return Response.json({ id: 'msg_01J8ALL001' }, { status: 200 });
    });

    const client = createMessagingClient<Catalog>({ binding: fetcher });
    const result = await client.send('multiChannel', {
      to: '+94770000001',
      locale: 'en',
      input: { alert: 'System Alert' },
      delivery: 'all',
    });

    expect(result).toEqual({ ok: true, id: 'msg_01J8ALL001' });
  });

  it('verifies client send and status return type contracts', async () => {
    type ClientInstance = MessagingClient<Catalog>;

    // send() returns Promise<ClientSendResult>
    type SendReturnType = Awaited<ReturnType<ClientInstance['send']>>;
    type TestSendReturnType = Expect<Equals<SendReturnType, ClientSendResult>>;
    assertType<TestSendReturnType>(true);

    // status() returns Promise<MessageRecord | null>
    type StatusReturnType = Awaited<ReturnType<ClientInstance['status']>>;
    type TestStatusReturnType = Expect<Equals<StatusReturnType, MessageRecord | null>>;
    assertType<TestStatusReturnType>(true);

    // Runtime assertion
    const createMessagingClient = await loadCreateMessagingClient();
    const fetcher = createMockFetcher(() => {
      return Response.json({ error: 'not found' }, { status: 404 });
    });

    const client = createMessagingClient<Catalog>({ binding: fetcher });
    const record = await client.status('msg_any');
    expect(record).toBeNull();
  });

  it('verifies client options interface requires Fetcher binding and accepts optional basePath', async () => {
    type ExpectedOptions = { binding: Fetcher; basePath?: string };
    type TestOptionsCompiles = Expect<
      Extends<ExpectedOptions, CreateMessagingClientOptions>
    >;
    assertType<TestOptionsCompiles>(true);

    const createMessagingClient = await loadCreateMessagingClient();
    const fetcher = createMockFetcher(() => {
      return Response.json({ id: 'msg_01J8OPT' }, { status: 200 });
    });

    const client = createMessagingClient<Catalog>({
      binding: fetcher,
      basePath: '/custom',
    });
    const result = await client.send('loginCode', {
      to: '+94770000001',
      locale: 'en',
      input: { code: '123456' },
    });
    expect(result).toEqual({ ok: true, id: 'msg_01J8OPT' });
  });
});
