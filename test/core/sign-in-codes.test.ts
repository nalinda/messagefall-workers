/**
 * Sign-in codes end to end: the shape a consumer delivering one-time codes (WhatsApp
 * authentication template first, SMS fallback, per-send locale) relies on.
 *
 * - The code is never at rest in plaintext: not in KV, not in the fallback timer's storage,
 *   not on the status record — across a send, a timed fallback and a failed webhook.
 * - `await: 'chain'` reports `accepted` / `undelivered` synchronously, also through the app and
 *   the client.
 * - A locale the WhatsApp template has no approved language for skips WhatsApp and goes to SMS.
 * - Sinhala / Tamil SMS text reaches the `http-sms` body builder unchanged.
 */

import type { ExecutionContext, Fetcher } from '@cloudflare/workers-types';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { createMessagingApp } from '../../src/app/hono.js';
import { createMessagingClient } from '../../src/client/index.js';
import { createMessaging } from '../../src/core/messaging.js';
import { OTP_ERROR_WITHHELD } from '../../src/core/redact.js';
import { FallbackTimer } from '../../src/durable/fallback-timer.js';
import type { MessagingEnv } from '../../src/env.js';
import { httpSms } from '../../src/providers/http-sms/index.js';
import type { RenderedSms, RenderedWhatsApp } from '../../src/providers/types.js';
import { defineTemplates, NoTemplateLanguageError } from '../../src/templates.js';
import { memoryKV, recordingProvider, TEST_ENC_KEY } from '../helpers/messaging.js';
import { createFakeDurableRuntime, type FakeClock, type FakeNamespace } from '../helpers/timer.js';
import { createMockExecutionContext } from '../helpers/webhook.js';

const TO = '+94771234567';
const CODE = '731904';

// The Sinhala and Tamil texts run past 160 characters, so any truncation or splitting at the
// GSM (160) or UCS-2 (70) segment length inside the library would show in the Unicode test.
const SI_TAIL =
  ' මෙම කේතය විනාඩි දහයකින් කල් ඉකුත් වේ. කිසිවෙකුටත් මෙම කේතය ලබා නොදෙන්න, බැංකුවකට හෝ අපගේ කාර්ය මණ්ඩලයට වුවද. ඔබ මෙය ඉල්ලා නොසිටියේ නම් මෙම පණිවිඩය නොසලකා හරින්න. ස්තූතියි.';
const TA_TAIL =
  ' இந்தக் குறியீடு பத்து நிமிடங்களில் காலாவதியாகும். இதை யாருடனும் பகிர வேண்டாம். நீங்கள் இதைக் கோரவில்லை என்றால் இந்தச் செய்தியைப் புறக்கணிக்கவும். நன்றி.';

const SMS_TEXT = new Map<string, (code: string) => string>([
  ['en', (code) => `Your sign-in code is ${code}`],
  ['si', (code) => `ඔබගේ පිවිසුම් කේතය ${code}${SI_TAIL}`],
  ['ta', (code) => `உங்கள் உள்நுழைவு குறியீடு ${code}${TA_TAIL}`],
]);

function smsText(code: string, locale: string): string {
  const render = SMS_TEXT.get(locale) ?? SMS_TEXT.get('en');
  return render ? render(code) : code;
}

const templates = defineTemplates({
  loginCode: {
    input: z.object({ code: z.string().regex(/^\d{6}$/) }),
    kind: 'otp',
    whatsapp: {
      template: 'login_code',
      // No approved Sinhala template: `si` sends skip WhatsApp and go straight to SMS.
      language: { en: 'en', ta: 'ta' },
      authentication: true,
      params: ({ code }: { code: string }) => [code],
    },
    sms: ({ code }: { code: string }, locale: string) => smsText(code, locale),
  },
});

/**
 * Every string anything in the deployment has persisted: KV values and the timer objects'
 * storage.
 */
function everythingAtRest(kv: ReturnType<typeof memoryKV>, ns?: FakeNamespace): string {
  const kvValues = kv.dump().values().toArray();
  const doValues = ns
    ? ns.objects
        .keys()
        .flatMap((name) => ns.storageOf(name).values())
        .toArray()
    : [];
  return JSON.stringify([kvValues, doValues]);
}

describe('sign-in codes: no plaintext code at rest', () => {
  let kv: ReturnType<typeof memoryKV>;
  let bindings: MessagingEnv;
  let ns: FakeNamespace;
  let clock: FakeClock;

  beforeEach(() => {
    kv = memoryKV();
    const runtime = createFakeDurableRuntime(FallbackTimer, () => bindings, Date.now());
    ns = runtime.ns;
    clock = runtime.clock;
    bindings = { MESSAGES_KV: kv, MESSAGES_ENC_KEY: TEST_ENC_KEY, FALLBACK_TIMER: ns.namespace };
  });

  afterEach(() => {
    clock.restore();
  });

  it('keeps the code out of KV and Durable Object storage through a timed fallback to SMS', async () => {
    const wa = recordingProvider<RenderedWhatsApp>('whatsapp', 'wa');
    const sms = recordingProvider<RenderedSms>('sms', 'sms');
    const messaging = createMessaging(bindings, {
      templates,
      providers: () => ({ whatsapp: wa, sms }),
    });

    const { id } = await messaging.send({
      template: 'loginCode',
      to: TO,
      locale: 'en',
      input: { code: CODE },
    });

    // WhatsApp accepted and nothing came back: the render input and the timer are both armed.
    expect(kv.dump().has(`in:${id}`)).toBe(true);
    expect(ns.storageOf(id).size).toBeGreaterThan(0);
    expect(everythingAtRest(kv, ns)).not.toContain(CODE);

    await clock.advance(30_000);

    // The alarm opened the sealed input and rendered SMS with the real code...
    expect(sms.calls).toHaveLength(1);
    expect(sms.calls[0].text).toBe(`Your sign-in code is ${CODE}`);
    // ...and nothing it left behind contains it.
    expect(everythingAtRest(kv, ns)).not.toContain(CODE);
  });

  it("uses the template's own timeout over the per-kind default", async () => {
    const sms = recordingProvider<RenderedSms>('sms', 'sms');
    const quick = defineTemplates({ loginCode: { ...templates.loginCode, timeout: 10_000 } });
    const messaging = createMessaging(bindings, {
      templates: quick,
      providers: () => ({ whatsapp: recordingProvider<RenderedWhatsApp>('whatsapp', 'wa'), sms }),
    });

    await messaging.send({ template: 'loginCode', to: TO, locale: 'en', input: { code: CODE } });
    await clock.advance(10_000);

    expect(sms.calls).toHaveLength(1);
  });

  it('withholds a vendor error quoting the code on the record, keeping the error code', async () => {
    const wa = recordingProvider<RenderedWhatsApp>('whatsapp', 'wa', [
      { ok: false, error: `Invalid parameter ${CODE}`, code: 'graph:131008' },
    ]);
    const sms = recordingProvider<RenderedSms>('sms', 'sms', [
      { ok: false, error: `Gateway refused "Your sign-in code is ${CODE}"`, code: 'http:400' },
    ]);
    const messaging = createMessaging(bindings, {
      templates,
      providers: () => ({ whatsapp: wa, sms }),
    });

    const { id } = await messaging.send({
      template: 'loginCode',
      to: TO,
      locale: 'en',
      input: { code: CODE },
    });

    const record = await messaging.status(id);
    expect(record?.chain.attempts.map((a) => [a.error, a.errorCode])).toEqual([
      [OTP_ERROR_WITHHELD, 'graph:131008'],
      [OTP_ERROR_WITHHELD, 'http:400'],
    ]);
    expect(everythingAtRest(kv, ns)).not.toContain(CODE);
  });
});

function env(): MessagingEnv {
  return { MESSAGES_KV: memoryKV(), MESSAGES_ENC_KEY: TEST_ENC_KEY };
}

describe('sign-in codes: await: "chain"', () => {
  it('runs delivery before resolving even with an ExecutionContext, and reports accepted', async () => {
    const wa = recordingProvider<RenderedWhatsApp>('whatsapp', 'wa');
    const ctx = createMockExecutionContext();
    const messaging = createMessaging(env(), { templates, providers: () => ({ whatsapp: wa }) });

    const result = await messaging.send(
      { template: 'loginCode', to: TO, locale: 'en', input: { code: CODE }, await: 'chain' },
      ctx
    );

    expect(result.outcome).toBe('accepted');
    expect(wa.calls).toHaveLength(1);
  });

  it('reports undelivered when every channel in the chain fails immediately', async () => {
    const messaging = createMessaging(env(), {
      templates,
      providers: () => ({
        whatsapp: recordingProvider<RenderedWhatsApp>('whatsapp', 'wa', [
          { ok: false, error: 'nope' },
        ]),
        sms: recordingProvider<RenderedSms>('sms', 'sms', [{ ok: false, error: 'nope' }]),
      }),
    });

    const result = await messaging.send({
      template: 'loginCode',
      to: TO,
      locale: 'en',
      input: { code: CODE },
      await: 'chain',
    });

    expect(result.outcome).toBe('undelivered');
    const record = await messaging.status(result.id);
    expect(record?.chain.status).toBe('failed');
  });

  it('reports accepted when WhatsApp fails and SMS accepts', async () => {
    const messaging = createMessaging(env(), {
      templates,
      providers: () => ({
        whatsapp: recordingProvider<RenderedWhatsApp>('whatsapp', 'wa', [
          { ok: false, error: 'nope' },
        ]),
        sms: recordingProvider<RenderedSms>('sms', 'sms'),
      }),
    });

    const result = await messaging.send({
      template: 'loginCode',
      to: TO,
      locale: 'en',
      input: { code: CODE },
      await: 'chain',
    });

    expect(result.outcome).toBe('accepted');
  });

  it('leaves the default unchanged: an otp send with a context hands delivery to waitUntil', async () => {
    const wa = recordingProvider<RenderedWhatsApp>('whatsapp', 'wa');
    const ctx = createMockExecutionContext();
    const messaging = createMessaging(env(), { templates, providers: () => ({ whatsapp: wa }) });

    const result = await messaging.send(
      { template: 'loginCode', to: TO, locale: 'en', input: { code: CODE } },
      ctx
    );

    // No outcome: the send did not wait for the chain (timing is covered in otp.test.ts).
    expect(result).toEqual({ id: result.id });
    expect(ctx.promises.length).toBeGreaterThan(0);
  });

  it('carries undelivered through the app (502 + code) and the client (ok: false, code, id)', async () => {
    const bindings = env();
    const app = createMessagingApp({
      templates,
      providers: () => ({
        whatsapp: recordingProvider<RenderedWhatsApp>('whatsapp', 'wa', [
          { ok: false, error: 'nope' },
        ]),
        sms: recordingProvider<RenderedSms>('sms', 'sms', [{ ok: false, error: 'nope' }]),
      }),
    });
    const binding = {
      fetch: (input: string, init?: RequestInit) =>
        app.fetch(
          new Request(input, init),
          bindings,
          createMockExecutionContext() as unknown as ExecutionContext
        ),
    } as unknown as Fetcher;
    const client = createMessagingClient<typeof templates>({ binding });

    const result = await client.send('loginCode', {
      to: TO,
      locale: 'en',
      input: { code: CODE },
      await: 'chain',
    });

    expect(result).toMatchObject({ ok: false, status: 502, code: 'undelivered' });
    expect(result.ok ? undefined : result.id).toStartWith('msg_');
  });
});

describe('sign-in codes: locale with no approved WhatsApp template language', () => {
  it('skips WhatsApp without calling Meta and sends the Sinhala SMS', async () => {
    const wa = recordingProvider<RenderedWhatsApp>('whatsapp', 'wa');
    const sms = recordingProvider<RenderedSms>('sms', 'sms');
    const messaging = createMessaging(
      { MESSAGES_KV: memoryKV(), MESSAGES_ENC_KEY: TEST_ENC_KEY },
      { templates, providers: () => ({ whatsapp: wa, sms }) }
    );

    const result = await messaging.send({
      template: 'loginCode',
      to: TO,
      locale: 'si',
      input: { code: CODE },
      await: 'chain',
    });

    expect(result.outcome).toBe('accepted');
    expect(wa.calls).toHaveLength(0);
    expect(sms.calls.map((c) => c.text)).toEqual([smsText(CODE, 'si')]);
    const [whatsapp] = (await messaging.status(result.id))!.chain.attempts;
    expect(whatsapp).toMatchObject({
      channel: 'whatsapp',
      status: 'failed',
      errorCode: NoTemplateLanguageError.code,
    });
  });

  it('uses a default language when the template maps one', async () => {
    const wa = recordingProvider<RenderedWhatsApp>('whatsapp', 'wa');
    const withDefault = defineTemplates({
      loginCode: {
        ...templates.loginCode,
        whatsapp: { ...templates.loginCode.whatsapp, language: { en: 'en', default: 'en' } },
      },
    });
    const messaging = createMessaging(
      { MESSAGES_KV: memoryKV(), MESSAGES_ENC_KEY: TEST_ENC_KEY },
      { templates: withDefault, providers: () => ({ whatsapp: wa }) }
    );

    await messaging.send({ template: 'loginCode', to: TO, locale: 'si', input: { code: CODE } });

    expect(wa.calls[0].templateConfig?.language).toBe('en');
  });
});

describe('sign-in codes: Unicode SMS through http-sms', () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it.each(['si', 'ta'])(
    'hands the %s text to the body builder unchanged, however long',
    async (locale) => {
      const bodies: string[] = [];
      fetchSpy.mockImplementation(((_url: string, init?: RequestInit) => {
        bodies.push(typeof init?.body === 'string' ? init.body : '');
        return Promise.resolve(Response.json({ id: 'sms_1' }));
      }) as unknown as typeof fetch);
      const seen: string[] = [];
      const sms = httpSms({
        url: 'https://sms.example.lk/send',
        headers: { authorization: 'Bearer test' },
        body: (m) => {
          seen.push(m.text);
          return { to: m.to, text: m.text, unicode: true };
        },
      });
      const messaging = createMessaging(
        { MESSAGES_KV: memoryKV(), MESSAGES_ENC_KEY: TEST_ENC_KEY },
        { templates, providers: () => ({ sms }), delivery: { fallback: ['sms'] } }
      );

      await messaging.send({ template: 'loginCode', to: TO, locale, input: { code: CODE } });

      const expected = smsText(CODE, locale);
      expect(expected.length).toBeGreaterThan(160);
      expect(seen).toEqual([expected]);
      expect(JSON.parse(bodies[0]) as unknown).toEqual({ to: TO, text: expected, unicode: true });
    }
  );
});
