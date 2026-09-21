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

import type { Messaging } from '../src/core/messaging.js';
import type { Channel } from '../src/providers/types.js';
import { defineTemplates, type InputOf, render, type TemplateDef } from '../src/templates.js';

// Type-level assertion helpers
type Extends<A, B> = A extends B ? true : false;
type Expect<T extends true> = T;
type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

function assertType<T>(_value: T): void {
  // Compile-time type verification helper
}

const sendTypingCatalog = defineTemplates({
  loginCode: {
    input: z.object({ code: z.string() }),
    kind: 'otp' as const,
    sms: ({ code }: { code: string }) => `Code: ${code}`,
  },
});

/**
 * The sends the catalogue's types must reject, written as real call sites.
 *
 * Never executed: `ts-check` covers `test/`, and each `@ts-expect-error` below is itself the
 * assertion — the build fails if the error it marks stops happening.
 */
async function rejectedSends(messaging: Messaging<typeof sendTypingCatalog>): Promise<void> {
  const envelope = { to: '+94770000001', locale: 'en' } as const;

  // @ts-expect-error - "nonExistentTemplate" is not a template in the catalogue.
  await messaging.send({ template: 'nonExistentTemplate', ...envelope, input: { code: '123456' } });

  // @ts-expect-error - `wrongField` is not a field of loginCode's input.
  await messaging.send({ template: 'loginCode', ...envelope, input: { wrongField: 'x' } });

  // @ts-expect-error - loginCode's `code` is a string, not a number.
  await messaging.send({ template: 'loginCode', ...envelope, input: { code: 123_456 } });
}

describe('defineTemplates type-level specifications', () => {
  it('correctly infers InputOf<T, K> from a catalog definition', () => {
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
    type TestMatchFoundInputExact = Expect<Equals<MatchFoundInput, { title: string; url: string }>>;

    assertType<TestLoginCodeInputExact>(true);
    assertType<TestMatchFoundInputExact>(true);

    // Runtime assertion tied to template rendering
    const rendered = render(templates.loginCode, 'sms', { code: '123456' }, 'en');
    expect(rendered).toEqual({ text: 'Your code is 123456' });
  });

  it('verifies client send typing: correct send compiles, wrong template name or input fails', () => {
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

    // The rejections are asserted with `@ts-expect-error` on real `messaging.send(...)` call
    // sites in `rejectedSends` below, not on a helper type. `ts-check` runs over `test/`, so
    // those assertions fail the build the day one of the type errors stops happening — which a
    // `Not<Extends<...>>` assertion on a type alias cannot do.
    expect(typeof rejectedSends).toBe('function');
    expect(sendTypingCatalog.loginCode.kind).toBe('otp');

    // Runtime assertion: input the caller's own schema rejects fails during render. A short
    // code is NOT such an input — `z.string()` accepts it, and code format is the caller's
    // concern, so this package adds no length rule of its own.
    expect(() => render(templates.loginCode, 'sms', { code: 12 }, 'en')).toThrow();
    expect(render(templates.loginCode, 'sms', { code: '12' }, 'en')).toEqual({ text: 'Code: 12' });
  });

  it('verifies TemplateDef channel types and rejects delivery naming undefined channels at definition time', () => {
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
      defineTemplates(invalidCatalog as Record<string, TemplateDef<any>>)
    ).toThrow(/badDeliveryTemplate/);
  });
});
