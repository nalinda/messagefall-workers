/**
 * Tests for the Meta WhatsApp Cloud API provider's `send` (Issue #4).
 *
 * Acceptance criteria covered:
 * - Send tests against a mocked endpoint: template message body, text
 *   message body, 200 returns the id, 400 maps to non-retryable with the
 *   Graph message, 429 and 500 map to retryable.
 * - Graph error codes 130429 and 131056 are retryable regardless of HTTP status.
 *
 * The "not in the root bundle" criterion is covered in test/exports.test.ts
 * against the built output.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { createMessaging, defineTemplates } from '../../../src/index.js';
import { metaWhatsApp } from '../../../src/providers/meta-whatsapp/index.js';
import type { OutboundMeta, RenderedWhatsApp } from '../../../src/providers/types.js';
import { newEnv } from '../../helpers/messaging.js';
import { testConfig } from './fixtures.js';

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function graphError(code: number, message: string, status: number): Response {
  return Response.json(
    { error: { message, type: 'OAuthException', code, fbtrace_id: 'trace' } },
    { status }
  );
}

function bodyOf(call: Captured | undefined): Record<string, unknown> {
  const raw = call?.init?.body;
  if (typeof raw !== 'string') throw new TypeError(`expected a string body, got ${typeof raw}`);
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * `to` is sent exactly as received (E.164 is validated upstream) and is
 * checked exactly; the rest of the body is matched on the fields the issue
 * names, so optional Cloud API fields such as `recipient_type` are allowed.
 */
function withoutRecipient(body: Record<string, unknown>): Record<string, unknown> {
  const { to, ...rest } = body;
  expect(to).toBe('+1771234567');
  return rest;
}

type WhatsAppMessage = RenderedWhatsApp & OutboundMeta;

// `OutboundMeta.template` (the catalogue name) and `RenderedWhatsApp.templateConfig` (the Meta
// template to send) have different keys, so the intersection the provider actually receives
// can be written out in full — no cast, and both concepts survive the merge.
function message(rendered: RenderedWhatsApp, kind: OutboundMeta['kind']): WhatsAppMessage {
  const meta: OutboundMeta = {
    to: '+1771234567',
    messageId: 'msg_test_001',
    template: 'loginCode',
    kind,
    locale: 'en',
  };
  return { ...meta, ...rendered };
}

const templateMessage = message(
  { templateConfig: { name: 'otp_code', language: 'en', params: ['482910', '10'] } },
  'otp'
);

const textMessage = message({ text: 'Your match is ready' }, 'notification');

describe('metaWhatsApp provider: send', () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockFetch(response: () => Response): Captured[] {
    const calls: Captured[] = [];
    fetchSpy.mockImplementation(((url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: url instanceof Request ? url.url : String(url), init });
      return Promise.resolve(response());
    }) as unknown as typeof fetch);
    return calls;
  }

  it('has the default name and the whatsapp channel', () => {
    const provider = metaWhatsApp(testConfig);
    expect(provider.name).toBe('meta-whatsapp');
    expect(provider.channel).toBe('whatsapp');
    expect(metaWhatsApp({ ...testConfig, name: 'wa-primary' }).name).toBe('wa-primary');
  });

  it('POSTs a template message to graph.facebook.com/<v>/<phoneNumberId>/messages with the Cloud API body', async () => {
    const calls = mockFetch(() =>
      Response.json({ messages: [{ id: 'wamid.template.1' }] }, { status: 200 })
    );

    const provider = metaWhatsApp(testConfig);
    await provider.send(templateMessage);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe('https://graph.facebook.com/v23.0/123456789012345/messages');
    expect(call.init?.method).toBe('POST');

    const headers = new Headers(call.init?.headers as Record<string, string> | undefined);
    expect(headers.get('authorization')).toBe('Bearer EAAB-test-token');
    expect(headers.get('content-type')).toBe('application/json');

    expect(withoutRecipient(bodyOf(call))).toMatchObject({
      messaging_product: 'whatsapp',
      type: 'template',
      template: {
        name: 'otp_code',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: '482910' },
              { type: 'text', text: '10' },
            ],
          },
        ],
      },
    });
  });

  it('sends an authentication template as the body + copy-code button pair Meta documents', async () => {
    const calls = mockFetch(() =>
      Response.json({ messages: [{ id: 'wamid.auth.1' }] }, { status: 200 })
    );

    const provider = metaWhatsApp(testConfig);
    await provider.send(
      message(
        {
          templateConfig: {
            name: 'login_code',
            language: 'si',
            params: ['482910'],
            authentication: true,
          },
        },
        'otp'
      )
    );

    expect(withoutRecipient(bodyOf(calls[0]))).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      type: 'template',
      template: {
        name: 'login_code',
        language: { code: 'si' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '482910' }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: '482910' }],
          },
        ],
      },
    });
  });

  it('refuses an authentication template that does not carry exactly one param', async () => {
    const calls = mockFetch(() => Response.json({}, { status: 200 }));

    const result = await metaWhatsApp(testConfig).send(
      message(
        {
          templateConfig: {
            name: 'login_code',
            language: 'en',
            params: ['482910', '10'],
            authentication: true,
          },
        },
        'otp'
      )
    );

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('honours a custom apiVersion in the endpoint', async () => {
    const calls = mockFetch(() =>
      Response.json({ messages: [{ id: 'wamid.version.1' }] }, { status: 200 })
    );

    const provider = metaWhatsApp({ ...testConfig, apiVersion: 'v21.0' });
    await provider.send(templateMessage);

    expect(calls[0]?.url).toBe('https://graph.facebook.com/v21.0/123456789012345/messages');
  });

  it('POSTs a text message as { type: "text", text: { body } }', async () => {
    const calls = mockFetch(() =>
      Response.json({ messages: [{ id: 'wamid.text.1' }] }, { status: 200 })
    );

    const provider = metaWhatsApp(testConfig);
    await provider.send(textMessage);

    expect(calls).toHaveLength(1);
    expect(withoutRecipient(bodyOf(calls[0]))).toMatchObject({
      messaging_product: 'whatsapp',
      type: 'text',
      text: { body: 'Your match is ready' },
    });
  });

  it('returns providerId from messages[0].id on 200', async () => {
    mockFetch(() =>
      Response.json(
        {
          messaging_product: 'whatsapp',
          contacts: [{ input: '+1771234567', wa_id: '1771234567' }],
          messages: [{ id: 'wamid.sent.200.first' }, { id: 'wamid.sent.200.second' }],
        },
        { status: 200 }
      )
    );

    const provider = metaWhatsApp(testConfig);
    const result = await provider.send(templateMessage);

    expect(result).toEqual({ ok: true, providerId: 'wamid.sent.200.first' });
  });

  it('maps a 400 Graph error to a non-retryable failure carrying the Graph message and code', async () => {
    mockFetch(() => graphError(132_000, 'Number of parameters does not match', 400));

    const provider = metaWhatsApp(testConfig);
    const result = await provider.send(templateMessage);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable ?? false).toBe(false);
    expect(result.error).toContain('Number of parameters does not match');
    expect(result.error).toContain('132000');
    expect(result.code).toBe('graph:132000');
  });

  it('reports http:<status> for a non-Graph error body and network for a thrown fetch', async () => {
    mockFetch(() => new Response('Service Unavailable', { status: 503 }));
    const http = await metaWhatsApp(testConfig).send(templateMessage);
    expect(http.ok ? undefined : http.code).toBe('http:503');

    fetchSpy.mockImplementation((() =>
      Promise.reject(new Error('down'))) as unknown as typeof fetch);
    const network = await metaWhatsApp(testConfig).send(templateMessage);
    expect(network.ok ? undefined : network.code).toBe('network');
  });

  it.each([
    ['HTTP 429', () => graphError(4, 'Application request limit reached', 429)],
    ['HTTP 500', () => graphError(1, 'An unknown error occurred', 500)],
    ['HTTP 503 with a non-JSON body', () => new Response('Service Unavailable', { status: 503 })],
    ['Graph code 130429 on HTTP 400', () => graphError(130_429, 'Rate limit hit', 400)],
    [
      'Graph code 131056 on HTTP 400',
      () => graphError(131_056, '(Business Account, Consumer Account) pair rate limit hit', 400),
    ],
  ])('maps %s to retryable: true', async (_label, response) => {
    mockFetch(response);

    const provider = metaWhatsApp(testConfig);
    const result = await provider.send(templateMessage);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(true);
  });

  it('maps a thrown fetch to a failure carrying the error message', async () => {
    fetchSpy.mockImplementation((() =>
      Promise.reject(new Error('network down'))) as unknown as typeof fetch);

    const provider = metaWhatsApp(testConfig);
    const result = await provider.send(templateMessage);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('network down');
  });
});

describe('metaWhatsApp provider: end to end from the template catalogue', () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('carries a catalogue template render all the way to the Graph body, keeping both names', async () => {
    const calls: Captured[] = [];
    fetchSpy.mockImplementation(((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(Response.json({ messages: [{ id: 'wamid.e2e.1' }] }, { status: 200 }));
    }) as unknown as typeof fetch);

    const provider = metaWhatsApp(testConfig);
    // Wrap the real provider so the test can see the exact payload the pipeline assembles,
    // then hand it straight on — no re-shaping.
    const seen: (RenderedWhatsApp & OutboundMeta)[] = [];
    const spyProvider: typeof provider = {
      ...provider,
      send: (message) => {
        seen.push(message);
        return provider.send(message);
      },
    };

    const templates = defineTemplates({
      loginCode: {
        input: z.object({ code: z.string().min(1) }),
        kind: 'otp',
        whatsapp: {
          template: 'auth_code',
          language: { en: 'en_US' },
          params: ({ code }: { code: string }) => [code],
        },
      },
    });

    const messaging = createMessaging(newEnv(), {
      templates,
      providers: () => ({ whatsapp: spyProvider }),
      delivery: { fallback: ['whatsapp'] },
    });

    const { id } = await messaging.send({
      template: 'loginCode',
      to: '+1771234567',
      locale: 'en',
      input: { code: '482910' },
    });

    // 1. The payload the pipeline built carries BOTH concepts, under their own keys.
    expect(seen).toHaveLength(1);
    expect(seen[0].template).toBe('loginCode');
    expect(seen[0].templateConfig).toEqual({
      name: 'auth_code',
      language: 'en_US',
      params: ['482910'],
    });

    // 2. The Graph body is built from `templateConfig`, not from the catalogue name.
    expect(calls).toHaveLength(1);
    const body = bodyOf(calls[0]);
    expect(body.type).toBe('template');
    expect(body.template).toMatchObject({
      name: 'auth_code',
      language: { code: 'en_US' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: '482910' }] }],
    });

    // 3. The record keeps the catalogue name, as it always did.
    const record = await messaging.status(id);
    expect(record?.template).toBe('loginCode');
    expect(record?.chain.attempts[0]).toMatchObject({
      channel: 'whatsapp',
      status: 'sent',
      providerId: 'wamid.e2e.1',
    });
  });
});

describe('metaWhatsApp provider: authentication template from the catalogue', () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('a loginCode send produces the body + copy-code button components', async () => {
    const calls: Captured[] = [];
    fetchSpy.mockImplementation(((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(Response.json({ messages: [{ id: 'wamid.auth.e2e' }] }));
    }) as unknown as typeof fetch);

    const templates = defineTemplates({
      loginCode: {
        input: z.object({ code: z.string().regex(/^\d{6}$/) }),
        kind: 'otp',
        whatsapp: {
          template: 'login_code',
          language: { en: 'en', ta: 'ta' },
          authentication: true,
          params: ({ code }: { code: string }) => [code],
        },
        sms: ({ code }: { code: string }) => `Your code is ${code}`,
      },
    });

    const messaging = createMessaging(newEnv(), {
      templates,
      providers: () => ({ whatsapp: metaWhatsApp(testConfig) }),
      delivery: { fallback: ['whatsapp'] },
    });

    await messaging.send({
      template: 'loginCode',
      to: '+94771234567',
      locale: 'ta',
      input: { code: '482910' },
    });

    expect(bodyOf(calls[0]).template).toEqual({
      name: 'login_code',
      language: { code: 'ta' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: '482910' }] },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: '482910' }],
        },
      ],
    });
  });
});
