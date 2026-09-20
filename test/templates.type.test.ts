/**
 * Type-level tests for defineTemplates, TemplateDef, and InputOf (Issue #2).
 *
 * Acceptance criteria:
 * - Type-level tests: correct send compiles; wrong input field, wrong template name,
 *   and a delivery naming an undefined channel fail to compile where the type system can catch them.
 * - InputOf<T, K> extracts the typed input from the catalog type alone.
 * - Bun-test-executable with runtime assertions tied to actual behavior in src/.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { Channel } from '../src/providers/types.js';
import {
  type InputOf,
  loadTemplatesApi,
  type TemplateDef,
} from './helpers/templates.js';

// Type-level assertion helpers
type Extends<A, B> = A extends B ? true : false;
type Not<T extends boolean> = T extends true ? false : true;
type Expect<T extends true> = T;
type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
  ? true
  : false;

function assertType<T>(_value: T): void {
  // Compile-time type verification helper
}

describe('defineTemplates type-level specifications', () => {
  it('correctly infers InputOf<T, K> from a catalog definition', async () => {
    const { defineTemplates, render } = await loadTemplatesApi();

    const catalogDefs = {
      loginCode: {
        input: z.object({ code: z.string().length(6) }),
        kind: 'otp' as const,
        whatsapp: {
          template: 'auth_login_code',
          language: 'en',
          params: ({ code }: { code: string }) => [code],
        },
        sms: ({ code }: { code: string }) => `Your code is ${code}`,
      },
      matchFound: {
        input: z.object({ title: z.string(), url: z.string() }),
        kind: 'notification' as const,
        whatsapp: {
          template: 'match_alert',
          language: { en: 'en_US', default: 'en_US' },
          params: ({ title, url }: { title: string; url: string }) => [title, url],
        },
        email: {
          subject: ({ title }: { title: string }) => `Match: ${title}`,
          text: ({ title, url }: { title: string; url: string }) => `${title}\n${url}`,
        },
      },
    };

    const templates = defineTemplates(catalogDefs);
    expect(templates).toBeDefined();

    type CatalogType = typeof catalogDefs;

    // Type assertions: InputOf correctly extracts input shapes
    type LoginCodeInput = InputOf<CatalogType, 'loginCode'>;
    type MatchFoundInput = InputOf<CatalogType, 'matchFound'>;

    type TestLoginCodeInputExact = Expect<Equals<LoginCodeInput, { code: string }>>;
    type TestMatchFoundInputExact = Expect<
      Equals<MatchFoundInput, { title: string; url: string }>
    >;

    assertType<TestLoginCodeInputExact>(true);
    assertType<TestMatchFoundInputExact>(true);

    // Runtime assertion tied to template rendering
    const rendered = render(templates.loginCode, 'sms', { code: '123456' }, 'en');
    expect(rendered).toEqual({ text: 'Your code is 123456' });
  });

  it('verifies client send typing: correct send compiles, wrong template name or input fails', async () => {
    const { defineTemplates, render } = await loadTemplatesApi();

    const catalogDefs = {
      loginCode: {
        input: z.object({ code: z.string() }),
        kind: 'otp' as const,
        sms: ({ code }: { code: string }) => `Code: ${code}`,
      },
      orderShipped: {
        input: z.object({ orderId: z.string(), trackingUrl: z.string() }),
        kind: 'notification' as const,
        email: {
          subject: ({ orderId }: { orderId: string }) => `Order #${orderId}`,
          text: ({ trackingUrl }: { trackingUrl: string }) => `Track at ${trackingUrl}`,
        },
      },
    };

    const templates = defineTemplates(catalogDefs);
    expect(templates).toBeDefined();

    type CatalogType = typeof catalogDefs;

    // Verify valid send parameters type-check
    type ValidLoginCodeSend = {
      template: 'loginCode';
      options: { to: string; input: { code: string } };
    };
    type TestValidSend = Expect<
      Extends<
        ValidLoginCodeSend['options']['input'],
        InputOf<CatalogType, ValidLoginCodeSend['template']>
      >
    >;
    assertType<TestValidSend>(true);

    // Verify wrong input field fails type check
    type WrongFieldInput = { wrongField: string };
    type TestWrongFieldRejected = Expect<
      Not<Extends<WrongFieldInput, InputOf<CatalogType, 'loginCode'>>>
    >;
    assertType<TestWrongFieldRejected>(true);

    // Verify wrong field type fails type check (e.g. number instead of string)
    type WrongTypeInput = { code: number };
    type TestWrongTypeRejected = Expect<
      Not<Extends<WrongTypeInput, InputOf<CatalogType, 'loginCode'>>>
    >;
    assertType<TestWrongTypeRejected>(true);

    // Verify wrong template name fails keyof check
    type UnknownTemplateName = 'nonExistentTemplate';
    type TestUnknownTemplateRejected = Expect<
      Not<Extends<UnknownTemplateName, keyof CatalogType>>
    >;
    assertType<TestUnknownTemplateRejected>(true);

    // Runtime assertion: invalid input rejected during render
    expect(() => render(templates.loginCode, 'sms', { code: '12' }, 'en')).toThrow();
  });

  it('verifies TemplateDef channel types and rejects delivery naming undefined channels at definition time', async () => {
    const { defineTemplates } = await loadTemplatesApi();

    // TemplateDef accepts valid channel rendering functions and valid delivery override
    const smsDef: TemplateDef<{ message: string }> = {
      input: z.object({ message: z.string() }),
      kind: 'notification',
      sms: ({ message }, locale) => `[${locale}] ${message}`,
      delivery: {
        fallback: ['sms'],
      },
    };

    expect(smsDef.kind).toBe('notification');
    expect(typeof smsDef.sms).toBe('function');

    type TestSmsDefValid = Expect<Extends<typeof smsDef, TemplateDef<{ message: string }>>>;
    assertType<TestSmsDefValid>(true);

    // Invalid delivery configuration naming an undefined channel throws at definition time
    const invalidCatalog = {
      badDeliveryTemplate: {
        input: z.object({ message: z.string() }),
        kind: 'notification' as const,
        sms: ({ message }: { message: string }) => message,
        delivery: {
          fallback: ['whatsapp' as Channel],
        },
      },
    };

    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      defineTemplates(invalidCatalog as Record<string, TemplateDef<any>>),
    ).toThrow(/badDeliveryTemplate/);
  });
});
