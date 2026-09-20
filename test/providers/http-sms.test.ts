/**
 * Tests for the Generic HTTP SMS Provider (Issue #19).
 *
 * Acceptance criteria:
 * - Test with a fake regional gateway: POST with { to, text }, response { id }; providerId is the id.
 * - GET variant with query parameters built from url as a function.
 * - ok and retryable mappers override the defaults; 4xx is non-retryable by default, 429 and 5xx retryable, thrown fetch retryable.
 * - A caller-supplied webhook.parse is exposed and dispatches through provider contract.
 * - Not present in the root bundle when unused.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { createMessaging } from '../../src/index.js';
import { httpSms } from '../../src/providers/http-sms/index.js';
import type { OutboundMeta, RenderedSms, StatusEvent } from '../../src/providers/types.js';
import { newEnv, pingTemplates } from '../helpers/messaging.js';

describe('httpSms provider', () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockFetch(fn: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
    fetchSpy.mockImplementation(fn as unknown as typeof fetch);
  }

  const sampleMeta: RenderedSms & OutboundMeta = {
    text: 'Your verification code is 482910',
    to: '+94771234567',
    messageId: 'msg_test_001',
    template: 'otp',
    kind: 'otp',
    locale: 'en',
  };

  it('sends POST request to fake regional gateway with { to, text } body and extracts providerId from { id } response', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;

    mockFetch((url, init) => {
      capturedUrl = url instanceof Request ? url.url : String(url);
      capturedInit = init;
      return Promise.resolve(Response.json({ id: 'gw_resp_987654' }, { status: 200 }));
    });

    const provider = httpSms({
      url: 'https://sms-gateway.example.com/api/v1/send',
      body: (m) => ({ to: m.to, text: m.text }),
      messageId: (json: unknown) => (json as { id?: string }).id,
    });

    expect(provider.name).toBe('http-sms');
    expect(provider.channel).toBe('sms');

    const result = await provider.send(sampleMeta);

    expect(capturedUrl).toBe('https://sms-gateway.example.com/api/v1/send');
    expect(capturedInit).toBeDefined();
    expect(capturedInit?.method).toBe('POST');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(capturedInit?.body).toBe(
      JSON.stringify({ to: '+94771234567', text: 'Your verification code is 482910' })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.providerId).toBe('gw_resp_987654');
    }
  });

  it('supports GET variant with query parameters dynamically constructed from url function', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;

    mockFetch((url, init) => {
      capturedUrl = url instanceof Request ? url.url : String(url);
      capturedInit = init;
      return Promise.resolve(Response.json({ message_id: 'get_msg_112233' }, { status: 200 }));
    });

    const provider = httpSms({
      method: 'GET',
      url: (m) =>
        `https://sms-gateway.example.com/quicksend?dest=${encodeURIComponent(m.to)}&content=${encodeURIComponent(m.text)}`,
      messageId: (json: unknown) => (json as { message_id?: string }).message_id,
    });

    const result = await provider.send(sampleMeta);

    const expectedUrl = `https://sms-gateway.example.com/quicksend?dest=${encodeURIComponent(sampleMeta.to)}&content=${encodeURIComponent(sampleMeta.text)}`;
    expect(capturedUrl).toBe(expectedUrl);
    expect(capturedInit).toBeDefined();
    expect(capturedInit?.method).toBe('GET');
    expect(capturedInit?.body).toBeUndefined();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.providerId).toBe('get_msg_112233');
    }
  });

  it('gates JSON parsing on response Content-Type header', async () => {
    let passedJson: unknown = 'NOT_SET';

    mockFetch(() =>
      Promise.resolve(
        new Response('SUCCESS: id=txt_9988', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      )
    );

    const provider = httpSms({
      url: 'https://sms-gateway.example.com/plain',
      ok: (_res, json) => {
        passedJson = json;
        return true;
      },
      messageId: (_json, response) => {
        expect(passedJson).toBeUndefined();
        return response.ok ? 'plain_id_1' : undefined;
      },
    });

    const result = await provider.send(sampleMeta);
    expect(result.ok).toBe(true);
    expect(passedJson).toBeUndefined();
    if (result.ok) {
      expect(result.providerId).toBe('plain_id_1');
    }
  });

  it('handles invalid JSON gracefully when content-type is application/json', async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response('not-a-valid-json-string', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const provider = httpSms({
      url: 'https://sms-gateway.example.com/broken-json',
      messageId: (json) => (json as { id?: string } | undefined)?.id,
    });

    const result = await provider.send(sampleMeta);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.providerId).toBeUndefined();
    }
  });

  it('applies default ok and retryable mappings (4xx non-retryable, 429 & 5xx retryable)', async () => {
    const testCases: Array<{
      status: number;
      body: string;
      expectedOk: boolean;
      expectedRetryable: boolean;
    }> = [
      { status: 200, body: 'OK', expectedOk: true, expectedRetryable: false },
      { status: 201, body: 'Created', expectedOk: true, expectedRetryable: false },
      { status: 400, body: 'Bad Request: invalid phone', expectedOk: false, expectedRetryable: false },
      { status: 401, body: 'Unauthorized', expectedOk: false, expectedRetryable: false },
      { status: 403, body: 'Forbidden', expectedOk: false, expectedRetryable: false },
      { status: 404, body: 'Endpoint Not Found', expectedOk: false, expectedRetryable: false },
      { status: 422, body: 'Unprocessable Entity', expectedOk: false, expectedRetryable: false },
      { status: 429, body: 'Too Many Requests', expectedOk: false, expectedRetryable: true },
      { status: 500, body: 'Internal Server Error', expectedOk: false, expectedRetryable: true },
      { status: 502, body: 'Bad Gateway', expectedOk: false, expectedRetryable: true },
      { status: 503, body: 'Service Unavailable', expectedOk: false, expectedRetryable: true },
      { status: 504, body: 'Gateway Timeout', expectedOk: false, expectedRetryable: true },
    ];

    for (const tc of testCases) {
      mockFetch(() =>
        Promise.resolve(
          new Response(tc.body, {
            status: tc.status,
            headers: { 'content-type': 'text/plain' },
          })
        )
      );

      const provider = httpSms({
        url: 'https://sms-gateway.example.com/send',
      });

      const result = await provider.send(sampleMeta);
      expect(result.ok).toBe(tc.expectedOk);
      if (!result.ok) {
        expect(result.retryable).toBe(tc.expectedRetryable);
        expect(result.error).toBe(`${tc.status} ${tc.body}`);
      }
    }
  });

  it('allows overriding ok and retryable via custom mappers', async () => {
    mockFetch(() =>
      Promise.resolve(Response.json({ status: 'FAILED', reason: 'NO_CREDIT' }, { status: 200 }))
    );

    const provider = httpSms({
      url: 'https://sms-gateway.example.com/send',
      ok: (_res, json) => (json as { status?: string }).status === 'SUCCESS',
      retryable: (_res, json) => (json as { reason?: string }).reason === 'TEMPORARY_OUTAGE',
    });

    const result = await provider.send(sampleMeta);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('200');
    }
  });

  it('treats network errors (thrown fetch) as retryable: true', async () => {
    mockFetch(() => Promise.reject(new Error('Connection reset by peer (ECONNRESET)')));

    const provider = httpSms({
      url: 'https://sms-gateway.example.com/send',
    });

    const result = await provider.send(sampleMeta);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toBe('Connection reset by peer (ECONNRESET)');
    }
  });

  it('limits error snippet to the first 200 characters of response body', async () => {
    const longBody = 'A'.repeat(500);
    mockFetch(() =>
      Promise.resolve(
        new Response(longBody, {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        })
      )
    );

    const provider = httpSms({
      url: 'https://sms-gateway.example.com/send',
    });

    const result = await provider.send(sampleMeta);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(`500 ${'A'.repeat(200)}`);
      expect(result.error).toHaveLength(204);
    }
  });

  it('exposes caller-supplied webhook.parse and omits webhook when not provided', async () => {
    const dummyWebhookParser = async (request: Request): Promise<StatusEvent[]> => {
      const body = (await request.json()) as { message_ref: string; event: string };
      return [
        {
          providerId: body.message_ref,
          status: body.event === 'DELIVRD' ? 'delivered' : 'failed',
          at: new Date().toISOString(),
        },
      ];
    };

    const providerWithWebhook = httpSms({
      url: 'https://sms-gateway.example.com/send',
      webhook: { parse: dummyWebhookParser },
    });

    expect(providerWithWebhook.webhook).toBeDefined();
    expect(typeof providerWithWebhook.webhook?.parse).toBe('function');

    const fakeWebhookRequest = new Request('https://api.myworker.dev/webhooks/http-sms', {
      method: 'POST',
      body: JSON.stringify({ message_ref: 'gw_123', event: 'DELIVRD' }),
      headers: { 'content-type': 'application/json' },
    });

    const parsedEvents = await providerWithWebhook.webhook!.parse(fakeWebhookRequest);
    expect(parsedEvents).toHaveLength(1);
    expect(parsedEvents[0]?.providerId).toBe('gw_123');
    expect(parsedEvents[0]?.status).toBe('delivered');

    // Provider without webhook must have no webhook property
    const providerWithoutWebhook = httpSms({
      url: 'https://sms-gateway.example.com/send',
    });

    expect(providerWithoutWebhook.webhook).toBeUndefined();
    expect('webhook' in providerWithoutWebhook).toBe(false);
  });

  it('supports custom headers mapper and raw string bodies', async () => {
    let capturedInit: RequestInit | undefined;

    mockFetch((_url, init) => {
      capturedInit = init;
      return Promise.resolve(Response.json({ ok: true }, { status: 200 }));
    });

    const provider = httpSms({
      url: 'https://sms-gateway.example.com/send-form',
      headers: (m) => ({
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Message-ID': m.messageId,
      }),
      body: (m) => `phone=${encodeURIComponent(m.to)}&message=${encodeURIComponent(m.text)}`,
    });

    await provider.send(sampleMeta);

    expect(capturedInit).toBeDefined();
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(headers['X-Message-ID']).toBe('msg_test_001');
    const expectedBody = `phone=${encodeURIComponent(sampleMeta.to)}&message=${encodeURIComponent(sampleMeta.text)}`;
    expect(capturedInit?.body).toBe(expectedBody);
  });

  it('registers properly with createMessaging and supports custom name', async () => {
    const provider = httpSms({
      name: 'regional-gateway-lk',
      url: 'https://sms.example.lk/send',
      messageId: (json: unknown) => (json as { id?: string }).id,
    });

    expect(provider.name).toBe('regional-gateway-lk');
    expect(provider.channel).toBe('sms');

    let capturedUrl: string | undefined;
    mockFetch((url) => {
      capturedUrl = url instanceof Request ? url.url : String(url);
      return Promise.resolve(Response.json({ id: 'gw-777' }));
    });
    const messaging = createMessaging(newEnv(), {
      templates: pingTemplates,
      providers: () => ({ sms: provider }),
    });

    const { id } = await messaging.send({ template: 'ping', to: '+94771234567', locale: 'en', input: undefined });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toBe('https://sms.example.lk/send');
    const record = await messaging.status(id);
    expect(record!.chain.attempts[0]).toMatchObject({
      channel: 'sms',
      provider: 'regional-gateway-lk',
      providerId: 'gw-777',
      status: 'sent',
    });
  });

  it('is not present in the root bundle exports', async () => {
    const root = await import('../../src/index.js');
    // Ensure httpSms is not exported directly from root package to maintain bundle isolation
    expect((root as Record<string, unknown>).httpSms).toBeUndefined();
  });
});
