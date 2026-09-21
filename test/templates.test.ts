/**
 * Tests for defineTemplates, template catalog validation, and message rendering (Issue #2).
 *
 * Acceptance criteria:
 * - Runtime tests for the three definition-time validations:
 *   1. Throws naming the template if no channel rendering is defined.
 *   2. Throws naming the template if kind: 'otp' is combined with whatsapp.text.
 *   3. Throws naming the template if delivery names a channel the template does not define.
 * - Locale resolution of language record:
 *   - Exact locale match.
 *   - Fallback to 'default' key.
 *   - Render-time error if locale is missing and no 'default' key exists.
 *   - Static string language used directly.
 * - render() returns exact #18 shapes (RenderedWhatsApp, RenderedSms, RenderedEmail) and never mutates input.
 * - Both Zod and Valibot work via Standard Schema only (no direct dependency in src).
 * - definedChannels helper returns the defined channels.
 */

import { describe, expect, it } from 'bun:test';
import * as v from 'valibot';
import { z } from 'zod';

import type { Channel } from '../src/providers/types.js';
import {
  definedChannels,
  defineTemplates,
  render,
  type TemplateDef,
  TemplateValidationError,
} from '../src/templates.js';

interface UserScore {
  username: string;
  score: number;
}

describe('defineTemplates: Definition-time validation', () => {
  it('throws naming the template when no channel rendering is defined', () => {
    const emptyTemplateCatalog = {
      emptyNotification: {
        input: z.object({ userId: z.string() }),
        kind: 'notification' as const,
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => defineTemplates(emptyTemplateCatalog as Record<string, TemplateDef<any>>)).toThrow(
      /emptyNotification/,
    );
  });

  it('throws naming the template when kind: "otp" uses whatsapp.text', () => {
    const invalidOtpCatalog = {
      loginCode: {
        input: z.object({ code: z.string().length(6) }),
        kind: 'otp' as const,
        whatsapp: {
          text: ({ code }: { code: string }) => `Your code is ${code}`,
        },
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => defineTemplates(invalidOtpCatalog as Record<string, TemplateDef<any>>)).toThrow(
      /loginCode/,
    );
  });

  it('allows kind: "otp" with whatsapp.template (Meta authentication template)', () => {
    const validOtpCatalog = {
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
    };

    const templates = defineTemplates(validOtpCatalog);
    expect(templates).toBeDefined();
    expect(templates.loginCode).toBeDefined();
  });

  it('allows kind: "notification" with whatsapp.text', () => {
    const validNotificationCatalog = {
      orderAlert: {
        input: z.object({ orderId: z.string() }),
        kind: 'notification' as const,
        whatsapp: {
          text: ({ orderId }: { orderId: string }) => `Order ${orderId} updated`,
        },
      },
    };

    const templates = defineTemplates(validNotificationCatalog);
    expect(templates).toBeDefined();
    expect(templates.orderAlert).toBeDefined();
  });

  it('throws naming the template when delivery.fallback names an undefined channel', () => {
    const invalidDeliveryFallback = {
      smsOnlyOtp: {
        input: z.object({ code: z.string().length(6) }),
        kind: 'otp' as const,
        sms: ({ code }: { code: string }) => `Code: ${code}`,
        delivery: { fallback: ['whatsapp' as Channel, 'sms' as Channel] },
      },
    };

    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      defineTemplates(invalidDeliveryFallback as Record<string, TemplateDef<any>>),
    ).toThrow(/smsOnlyOtp/);
  });

  it('throws naming the template when delivery.always names an undefined channel', () => {
    const invalidDeliveryAlways = {
      smsOnlyAlert: {
        input: z.object({ msg: z.string() }),
        kind: 'notification' as const,
        sms: ({ msg }: { msg: string }) => msg,
        delivery: { always: ['email' as Channel] },
      },
    };

    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      defineTemplates(invalidDeliveryAlways as Record<string, TemplateDef<any>>),
    ).toThrow(/smsOnlyAlert/);
  });

  it('allows delivery: "all" shorthand for any defined channels', () => {
    const validAllDeliveryCatalog = {
      smsOnlyBroadcast: {
        input: z.object({ msg: z.string() }),
        kind: 'notification' as const,
        sms: ({ msg }: { msg: string }) => msg,
        delivery: 'all' as const,
      },
    };

    const templates = defineTemplates(validAllDeliveryCatalog);
    expect(templates.smsOnlyBroadcast).toBeDefined();
  });

  it('allows delivery override naming only defined channels', () => {
    const validOverrideCatalog = {
      multiChannelMessage: {
        input: z.object({ title: z.string(), body: z.string() }),
        kind: 'notification' as const,
        whatsapp: {
          text: ({ body }: { body: string }) => body,
        },
        sms: ({ body }: { body: string }) => body,
        email: {
          subject: ({ title }: { title: string }) => title,
          text: ({ body }: { body: string }) => body,
        },
        delivery: {
          fallback: ['whatsapp' as Channel, 'sms' as Channel],
          always: ['email' as Channel],
        },
      },
    };

    const templates = defineTemplates(validOverrideCatalog);
    expect(templates.multiChannelMessage).toBeDefined();
  });
});

describe('Locale resolution of language for WhatsApp templates', () => {
  it('resolves exact locale match from language record', () => {
    const template: TemplateDef<{ code: string }> = {
      input: z.object({ code: z.string() }),
      kind: 'otp',
      whatsapp: {
        template: 'auth_otp',
        language: { en: 'en_US', si: 'si_LK', ta: 'ta_LK', default: 'en_US' },
        params: ({ code }) => [code],
      },
    };

    const rendered = render(template, 'whatsapp', { code: '123456' }, 'si');
    expect(rendered).toEqual({
      templateConfig: {
        name: 'auth_otp',
        language: 'si_LK',
        params: ['123456'],
      },
    });
  });

  it('falls back to "default" key when locale is not in record', () => {
    const template: TemplateDef<{ code: string }> = {
      input: z.object({ code: z.string() }),
      kind: 'otp',
      whatsapp: {
        template: 'auth_otp',
        language: { en: 'en_US', si: 'si_LK', default: 'en_US' },
        params: ({ code }) => [code],
      },
    };

    const rendered = render(template, 'whatsapp', { code: '123456' }, 'fr');
    expect(rendered).toEqual({
      templateConfig: {
        name: 'auth_otp',
        language: 'en_US',
        params: ['123456'],
      },
    });
  });

  it('throws render-time error when locale is missing and no "default" key is present', () => {
    const template: TemplateDef<{ code: string }> = {
      input: z.object({ code: z.string() }),
      kind: 'otp',
      whatsapp: {
        template: 'auth_otp',
        language: { en: 'en_US', si: 'si_LK' },
        params: ({ code }) => [code],
      },
    };

    expect(() => render(template, 'whatsapp', { code: '123456' }, 'fr')).toThrow(
      /locale|language/i,
    );
  });

  it('uses static string language for any locale', () => {
    const template: TemplateDef<{ alertId: string }> = {
      input: z.object({ alertId: z.string() }),
      kind: 'notification',
      whatsapp: {
        template: 'system_alert',
        language: 'en_GB',
        params: ({ alertId }) => [alertId],
      },
    };

    const rendered = render(template, 'whatsapp', { alertId: 'ALT-101' }, 'de');
    expect(rendered).toEqual({
      templateConfig: {
        name: 'system_alert',
        language: 'en_GB',
        params: ['ALT-101'],
      },
    });
  });
});

describe('render() returns exact shapes from #18 and never mutates input', () => {
  it('returns RenderedWhatsApp with template shape', () => {
    const template: TemplateDef<{ code: string }> = {
      input: z.object({ code: z.string() }),
      kind: 'otp',
      whatsapp: {
        template: 'auth_otp',
        language: 'en',
        params: ({ code }, locale) => [code, locale],
      },
    };

    const result = render(template, 'whatsapp', { code: '654321' }, 'en');
    expect(result).toEqual({
      templateConfig: {
        name: 'auth_otp',
        language: 'en',
        params: ['654321', 'en'],
      },
    });
  });

  it('returns RenderedWhatsApp with text shape', () => {
    const template: TemplateDef<{ message: string }> = {
      input: z.object({ message: z.string() }),
      kind: 'notification',
      whatsapp: {
        text: ({ message }, locale) => `[${locale}] ${message}`,
      },
    };

    const result = render(template, 'whatsapp', { message: 'Support ticket updated' }, 'en');
    expect(result).toEqual({
      text: '[en] Support ticket updated',
    });
  });

  it('returns RenderedSms shape', () => {
    const template: TemplateDef<{ code: string }> = {
      input: z.object({ code: z.string() }),
      kind: 'otp',
      sms: ({ code }, locale) => (locale === 'si' ? `කේතය: ${code}` : `Code: ${code}`),
    };

    const resultSi = render(template, 'sms', { code: '778899' }, 'si');
    expect(resultSi).toEqual({
      text: 'කේතය: 778899',
    });

    const resultEn = render(template, 'sms', { code: '778899' }, 'en');
    expect(resultEn).toEqual({
      text: 'Code: 778899',
    });
  });

  it('returns RenderedEmail shape with subject, text, and optional html', () => {
    const template: TemplateDef<{ title: string; url: string }> = {
      input: z.object({ title: z.string(), url: z.string() }),
      kind: 'notification',
      email: {
        subject: ({ title }) => `Match: ${title}`,
        text: ({ title, url }) => `${title}\n${url}`,
        html: ({ title, url }) => `<a href="${url}">${title}</a>`,
      },
    };

    const result = render(
      template,
      'email',
      { title: 'New Item', url: 'https://example.com/item/1' },
      'en',
    );
    expect(result).toEqual({
      subject: 'Match: New Item',
      text: 'New Item\nhttps://example.com/item/1',
      html: '<a href="https://example.com/item/1">New Item</a>',
    });
  });

  it('never mutates input passed to render()', () => {
    const template: TemplateDef<{ code: string; details: { attempts: number } }> = {
      input: z.object({
        code: z.string(),
        details: z.object({ attempts: z.number() }),
      }),
      kind: 'otp',
      sms: ({ code }) => `Code: ${code}`,
    };

    const originalInput = Object.freeze({
      code: '123456',
      details: Object.freeze({ attempts: 1 }),
    });

    const result = render(template, 'sms', originalInput, 'en');
    expect(result).toEqual({ text: 'Code: 123456' });
    expect(originalInput).toEqual({
      code: '123456',
      details: { attempts: 1 },
    });
  });

  it('throws when rendering a channel that the template does not define', () => {
    const smsOnlyTemplate: TemplateDef<{ code: string }> = {
      input: z.object({ code: z.string() }),
      kind: 'otp',
      sms: ({ code }) => `Code: ${code}`,
    };

    expect(() => render(smsOnlyTemplate, 'email', { code: '123456' }, 'en')).toThrow(
      /email/i,
    );
  });
});

describe('Standard Schema validation during render()', () => {
  it('validates input with Standard Schema and transforms/surfaces values', () => {
    const template: TemplateDef<{ count: number }> = {
      input: z.object({ count: z.coerce.number() }),
      kind: 'notification',
      sms: ({ count }) => `Count: ${count}`,
    };

    const result = render(template, 'sms', { count: '42' }, 'en');
    expect(result).toEqual({ text: 'Count: 42' });
  });

  it('throws a typed validation error when input fails schema validation', () => {
    const template: TemplateDef<{ code: string }> = {
      input: z.object({ code: z.string().length(6) }),
      kind: 'otp',
      sms: ({ code }) => `Code: ${code}`,
    };

    expect(() => render(template, 'sms', { code: '12' }, 'en')).toThrow();
  });
});

describe('Zod and Valibot interoperability via Standard Schema only', () => {
  it('works with Zod schemas via Standard Schema (~standard)', () => {
    const zodCatalog = defineTemplates({
      zodOtp: {
        input: z.object({ code: z.string().length(6) }),
        kind: 'otp',
        sms: ({ code }: { code: string }) => `Zod OTP: ${code}`,
      },
    });

    const rendered = render(zodCatalog.zodOtp, 'sms', { code: '987654' }, 'en');
    expect(rendered).toEqual({ text: 'Zod OTP: 987654' });
    expect(() => render(zodCatalog.zodOtp, 'sms', { code: 'too_short' }, 'en')).toThrow();
  });

  it('works with a real Valibot schema via Standard Schema (~standard)', () => {
    // The actual `valibot` package, not a hand-written object literal claiming
    // `vendor: 'valibot'`: only a real schema proves this package reads nothing but
    // `~standard` and works against a second vendor's implementation of it.
    const scoreSchema = v.object({
      username: v.pipe(v.string(), v.minLength(1)),
      score: v.number(),
    });
    expect(scoreSchema['~standard'].vendor).toBe('valibot');

    const valibotCatalog = defineTemplates({
      gameNotification: {
        input: scoreSchema,
        kind: 'notification',
        sms: ({ username, score }: UserScore) => `Player ${username} scored ${score}`,
      },
    });

    const rendered = render(
      valibotCatalog.gameNotification,
      'sms',
      { username: 'alice', score: 100 },
      'en',
    );
    expect(rendered).toEqual({ text: 'Player alice scored 100' });

    // A wrong field type and a missing field both fail, through Valibot's own issues.
    expect(() =>
      render(valibotCatalog.gameNotification, 'sms', { username: 'alice', score: 'NaN' }, 'en'),
    ).toThrow(TemplateValidationError);
    expect(() =>
      render(valibotCatalog.gameNotification, 'sms', { username: 'alice' }, 'en'),
    ).toThrow(TemplateValidationError);
  });

  it('reports the Valibot issue path in the validation error message', () => {
    const catalog = defineTemplates({
      order: {
        input: v.object({ orderId: v.string() }),
        kind: 'notification',
        sms: ({ orderId }: { orderId: string }) => `Order ${orderId}`,
      },
    });

    let message = '';
    try {
      render(catalog.order, 'sms', { orderId: 42 }, 'en');
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('orderId');
  });

  it('transforms through a Valibot pipe and renders the transformed value', () => {
    const trimmedName = v.pipe(v.string(), v.trim());
    const catalog = defineTemplates({
      greeting: {
        input: v.object({ name: trimmedName }),
        kind: 'notification',
        sms: ({ name }: { name: string }) => `Hi ${name}!`,
      },
    });

    expect(render(catalog.greeting, 'sms', { name: '  alice  ' }, 'en')).toEqual({
      text: 'Hi alice!',
    });
  });
});

describe('definedChannels helper', () => {
  it('returns array of channels defined on the template', () => {
    const waAndSms: TemplateDef<{ code: string }> = {
      input: z.object({ code: z.string() }),
      kind: 'otp',
      whatsapp: {
        template: 'otp_tmpl',
        language: 'en',
        params: ({ code }) => [code],
      },
      sms: ({ code }) => code,
    };

    const emailOnly: TemplateDef<{ title: string }> = {
      input: z.object({ title: z.string() }),
      kind: 'notification',
      email: {
        subject: ({ title }) => title,
        text: ({ title }) => title,
      },
    };

    const allChannels: TemplateDef<{ msg: string }> = {
      input: z.object({ msg: z.string() }),
      kind: 'notification',
      whatsapp: { text: ({ msg }) => msg },
      sms: ({ msg }) => msg,
      email: {
        subject: ({ msg }) => msg,
        text: ({ msg }) => msg,
      },
    };

    expect(definedChannels(waAndSms)).toEqual(['whatsapp', 'sms']);
    expect(definedChannels(emailOnly)).toEqual(['email']);
    expect(definedChannels(allChannels)).toEqual(['whatsapp', 'sms', 'email']);
  });
});
