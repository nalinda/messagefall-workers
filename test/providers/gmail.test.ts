/**
 * Tests for the Gmail API Email Provider (Issue #20).
 *
 * Acceptance criteria:
 * - Token exchange with mocked oauth2.googleapis.com/token: token exchange on first send;
 *   second send within cached TTL (expires_in - 60s) makes no token request.
 * - Cross-isolate cache: with tokenCache set, a fresh isolate (fresh provider instance with empty
 *   memory cache) reads the cached token from KV instead of re-exchanging.
 * - Send: decoded base64url 'raw' MIME contains expected headers (From, To, Subject, MIME-Version, Date)
 *   and body parts for text-only and text+html (multipart/alternative, text before html, CRLF line endings, UTF-8);
 *   providerId from response.id.
 * - Subject with non-ASCII characters is RFC 2047 encoded correctly in the raw MIME.
 * - Error mapping: a 401 on send triggers exactly one token refresh and one retry; a second 401
 *   after that retry is a non-retryable failure (no infinite refresh loop).
 * - 429 and 5xx map to retryable: true; 400 and 403 map to non-retryable with Google's error message.
 * - Thrown fetch (network failure) maps to retryable: true.
 * - No webhook property on the returned Provider.
 * - Not present in the root bundle when unused (walk the built import graph).
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { createMessaging, defineTemplates } from '../../src/index.js';
import { gmail, type GmailConfig } from '../../src/providers/gmail/index.js';
import type { OutboundMeta, RenderedEmail } from '../../src/providers/types.js';
import { decodeBase64Url, decodeRfc2047 } from '../helpers/gmail.js';
import { memoryKV, newEnv } from '../helpers/messaging.js';

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

const rootDir = path.resolve(import.meta.dir, '../..');

function relativeImportsOf(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8');
  const staticSpecifier = /\bfrom\s*['"]([^'"]+)['"]/g;
  const dynamicSpecifier = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const bareSpecifier = /\bimport\s+['"]([^'"]+)['"]/g;

  const specifiers = [
    ...source.matchAll(staticSpecifier),
    ...source.matchAll(dynamicSpecifier),
    ...source.matchAll(bareSpecifier),
  ].map((match) => match[1]);

  return specifiers
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => path.resolve(path.dirname(file), specifier));
}

function walkImportGraph(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    if (!fs.existsSync(file)) continue;
    seen.add(file);
    queue.push(...relativeImportsOf(file));
  }
  return seen;
}

describe('Gmail provider (Issue #20)', () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

  const testConfig: GmailConfig = {
    clientId: 'test-client-id.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-test-client-secret',
    refreshToken: '1//0gTestRefreshToken1234567890',
    from: 'notifications@example.com',
  };

  const sampleEmail: RenderedEmail & OutboundMeta = {
    to: 'user@example.com',
    subject: 'Your Verification Code',
    text: 'Your verification code is 849201.',
    messageId: 'msg_gmail_001',
    template: 'otp',
    kind: 'otp',
    locale: 'en',
  };

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockFetchHandler(
    handler: (url: string, init?: RequestInit) => Promise<Response> | Response
  ): CapturedRequest[] {
    const calls: CapturedRequest[] = [];
    fetchSpy.mockImplementation(((url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : String(url);
      calls.push({ url: urlStr, init });
      return Promise.resolve(handler(urlStr, init));
    }) as unknown as typeof fetch);
    return calls;
  }

  it('implements the Provider contract with channel email, default name, and no webhook', () => {
    const provider = gmail(testConfig);

    expect(provider.name).toBe('gmail');
    expect(provider.channel).toBe('email');
    expect(typeof provider.send).toBe('function');
    expect(provider.webhook).toBeUndefined();
    expect('webhook' in provider).toBe(false);

    const namedProvider = gmail({ ...testConfig, name: 'custom-gmail' });
    expect(namedProvider.name).toBe('custom-gmail');
  });

  it('exchanges refresh token for access token on first send and reuses it for subsequent send within TTL', async () => {
    const provider = gmail(testConfig);

    let tokenExchangeCount = 0;
    let sendCount = 0;

    mockFetchHandler((url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        tokenExchangeCount++;
        expect(init?.method).toBe('POST');
        const body = typeof init?.body === 'string' ? init.body : '';
        expect(body).toContain('grant_type=refresh_token');
        expect(body).toContain('client_id=');
        expect(body).toContain('client_secret=');
        expect(body).toContain('refresh_token=');
        return Response.json(
          {
            access_token: 'ya29.initial_access_token_123',
            expires_in: 3600,
            token_type: 'Bearer',
          },
          { status: 200 }
        );
      }

      if (url.includes('gmail.googleapis.com/gmail/v1/users/me/messages/send')) {
        sendCount++;
        const headers = new Headers(init?.headers as Record<string, string> | undefined);
        expect(headers.get('authorization')).toBe('Bearer ya29.initial_access_token_123');
        return Response.json(
          {
            id: `gmail_msg_${sendCount}`,
            threadId: `thread_${sendCount}`,
          },
          { status: 200 }
        );
      }

      return new Response('Not Found', { status: 404 });
    });

    // First send: triggers token exchange + send
    const result1 = await provider.send(sampleEmail);
    expect(result1.ok).toBe(true);
    if (result1.ok) {
      expect(result1.providerId).toBe('gmail_msg_1');
    }
    expect(tokenExchangeCount).toBe(1);
    expect(sendCount).toBe(1);

    // Second send within TTL: reuses cached token, no new token exchange
    const result2 = await provider.send({ ...sampleEmail, messageId: 'msg_gmail_002' });
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.providerId).toBe('gmail_msg_2');
    }
    expect(tokenExchangeCount).toBe(1);
    expect(sendCount).toBe(2);
  });

  it('reads cached token from tokenCache KV in a simulated fresh isolate without exchanging token', async () => {
    const sharedKV = memoryKV();

    let tokenExchangeCount = 0;
    let sendCount = 0;

    mockFetchHandler((url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        tokenExchangeCount++;
        return Response.json(
          {
            access_token: 'ya29.kv_cached_token_999',
            expires_in: 3600,
            token_type: 'Bearer',
          },
          { status: 200 }
        );
      }

      if (url.includes('gmail.googleapis.com/gmail/v1/users/me/messages/send')) {
        sendCount++;
        const headers = new Headers(init?.headers as Record<string, string> | undefined);
        expect(headers.get('authorization')).toBe('Bearer ya29.kv_cached_token_999');
        return Response.json({ id: `gmail_kv_${sendCount}` }, { status: 200 });
      }

      return new Response('Not Found', { status: 404 });
    });

    // First isolate: exchanges token and stores in tokenCache KV
    const providerIsolate1 = gmail({ ...testConfig, tokenCache: sharedKV });
    const result1 = await providerIsolate1.send(sampleEmail);
    expect(result1.ok).toBe(true);
    expect(tokenExchangeCount).toBe(1);
    expect(sendCount).toBe(1);

    // Verify token was stored in KV
    const kvDump = sharedKV.dump();
    expect(kvDump.size).toBeGreaterThan(0);

    // Second isolate (fresh provider instance sharing the same KV tokenCache)
    const providerIsolate2 = gmail({ ...testConfig, tokenCache: sharedKV });
    const result2 = await providerIsolate2.send({ ...sampleEmail, messageId: 'msg_gmail_003' });
    expect(result2.ok).toBe(true);

    // Must NOT have made a second token exchange request
    expect(tokenExchangeCount).toBe(1);
    expect(sendCount).toBe(2);
  });

  it('encodes text-only email as base64url MIME with required headers and CRLF line endings', async () => {
    const provider = gmail(testConfig);

    let capturedSendBody: { raw?: string } | undefined;

    mockFetchHandler((url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'ya29.send_test_token', expires_in: 3600 }, { status: 200 });
      }
      if (url.includes('gmail.googleapis.com/gmail/v1/users/me/messages/send')) {
        const bodyStr = typeof init?.body === 'string' ? init.body : '';
        capturedSendBody = JSON.parse(bodyStr) as { raw?: string };
        return Response.json({ id: 'msg_sent_101', threadId: 'thread_101' }, { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const result = await provider.send({
      to: 'recipient@example.com',
      subject: 'Account Activation',
      text: 'Click here to activate your account: https://example.com/act',
      messageId: 'msg_raw_text',
      template: 'activation',
      kind: 'notification',
      locale: 'en',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.providerId).toBe('msg_sent_101');
    }

    expect(capturedSendBody).toBeDefined();
    expect(capturedSendBody?.raw).toBeDefined();

    const decodedMime = decodeBase64Url(capturedSendBody!.raw!);

    // Headers assertion
    expect(decodedMime).toContain('From: notifications@example.com');
    expect(decodedMime).toContain('To: recipient@example.com');
    expect(decodedMime).toContain('Subject: Account Activation');
    expect(decodedMime).toContain('MIME-Version: 1.0');
    expect(decodedMime).toMatch(/Date:\s*[A-Za-z]+,\s*\d{1,2}\s+[A-Za-z]+\s+\d{4}/);
    expect(decodedMime).toMatch(/Content-Type:\s*text\/plain;\s*charset="?utf-8"?/i);

    // Body assertion
    expect(decodedMime).toContain('Click here to activate your account: https://example.com/act');

    // Strict CRLF line endings
    expect(decodedMime).toContain('\r\n');
    const stripped = decodedMime.replaceAll('\r\n', '');
    expect(stripped).not.toContain('\n');
    expect(stripped).not.toContain('\r');
  });

  it('encodes multipart/alternative email with text before html when html is present', async () => {
    const provider = gmail(testConfig);

    let capturedSendBody: { raw?: string } | undefined;

    mockFetchHandler((url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'ya29.send_test_token', expires_in: 3600 }, { status: 200 });
      }
      if (url.includes('gmail.googleapis.com/gmail/v1/users/me/messages/send')) {
        const bodyStr = typeof init?.body === 'string' ? init.body : '';
        capturedSendBody = JSON.parse(bodyStr) as { raw?: string };
        return Response.json({ id: 'msg_sent_html_202' }, { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const result = await provider.send({
      to: 'customer@example.com',
      subject: 'Monthly Statement',
      text: 'Your statement is ready to view at https://example.com/st',
      html: '<h1>Your statement is ready</h1><p>Visit <a href="https://example.com/st">portal</a></p>',
      messageId: 'msg_raw_html',
      template: 'statement',
      kind: 'notification',
      locale: 'en',
    });

    expect(result.ok).toBe(true);
    expect(capturedSendBody).toBeDefined();

    const decodedMime = decodeBase64Url(capturedSendBody!.raw!);

    // Check multipart/alternative content-type and boundary
    expect(decodedMime).toMatch(/Content-Type:\s*multipart\/alternative;\s*boundary=/i);

    // Text part must precede HTML part
    const textPos = decodedMime.indexOf('Your statement is ready to view');
    const htmlPos = decodedMime.indexOf('<h1>Your statement is ready</h1>');

    expect(textPos).toBeGreaterThan(0);
    expect(htmlPos).toBeGreaterThan(0);
    expect(textPos).toBeLessThan(htmlPos);

    expect(decodedMime).toMatch(/Content-Type:\s*text\/plain/i);
    expect(decodedMime).toMatch(/Content-Type:\s*text\/html/i);

    // Strict CRLF line endings
    const stripped = decodedMime.replaceAll('\r\n', '');
    expect(stripped).not.toContain('\n');
    expect(stripped).not.toContain('\r');
  });

  it('correctly encodes non-ASCII Subject with RFC 2047 in the raw MIME payload', async () => {
    const provider = gmail(testConfig);

    let capturedSendBody: { raw?: string } | undefined;

    mockFetchHandler((url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'ya29.send_test_token', expires_in: 3600 }, { status: 200 });
      }
      if (url.includes('gmail.googleapis.com/gmail/v1/users/me/messages/send')) {
        const bodyStr = typeof init?.body === 'string' ? init.body : '';
        capturedSendBody = JSON.parse(bodyStr) as { raw?: string };
        return Response.json({ id: 'msg_sent_unicode_303' }, { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const unicodeSubject = '🚀 New login detected: San Francisco, CA (Café & Bakery)';
    const result = await provider.send({
      to: 'security@example.com',
      subject: unicodeSubject,
      text: 'We detected a new login.',
      messageId: 'msg_unicode_subject',
      template: 'securityAlert',
      kind: 'notification',
      locale: 'en',
    });

    expect(result.ok).toBe(true);
    expect(capturedSendBody).toBeDefined();

    const decodedMime = decodeBase64Url(capturedSendBody!.raw!);
    const lines = decodedMime.split('\r\n');
    const subjectLine = lines.find((line) => line.startsWith('Subject:'));
    expect(subjectLine).toBeDefined();
    const rawSubjectHeader = subjectLine!.slice('Subject:'.length).trim();

    expect(rawSubjectHeader).toMatch(/=\?[a-z0-9-]+\?[bq]\?[^?]+\?=/i);
    expect(decodeRfc2047(rawSubjectHeader)).toBe(unicodeSubject);
  });

  it('refreshes token on 401 response and retries once; returns success if retry succeeds', async () => {
    const provider = gmail(testConfig);

    let tokenExchangeCount = 0;
    let sendAttemptCount = 0;

    mockFetchHandler((url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        tokenExchangeCount++;
        return Response.json(
          {
            access_token: `ya29.token_round_${tokenExchangeCount}`,
            expires_in: 3600,
          },
          { status: 200 }
        );
      }

      if (url.includes('gmail.googleapis.com/gmail/v1/users/me/messages/send')) {
        sendAttemptCount++;
        const headers = new Headers(init?.headers as Record<string, string> | undefined);
        const auth = headers.get('authorization');

        // First send attempt receives 401 with old/expired token
        if (sendAttemptCount === 1) {
          expect(auth).toBe('Bearer ya29.token_round_1');
          return Response.json(
            {
              error: {
                code: 401,
                message: 'Request had invalid authentication credentials.',
                status: 'UNAUTHENTICATED',
              },
            },
            { status: 401 }
          );
        }

        // Second send attempt succeeds with refreshed token
        if (sendAttemptCount === 2) {
          expect(auth).toBe('Bearer ya29.token_round_2');
          return Response.json({ id: 'msg_retried_401_success' }, { status: 200 });
        }
      }

      return new Response('Not Found', { status: 404 });
    });

    const result = await provider.send(sampleEmail);

    expect(tokenExchangeCount).toBe(2);
    expect(sendAttemptCount).toBe(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.providerId).toBe('msg_retried_401_success');
    }
  });

  it('fails with retryable: false on a second 401 after retry (no infinite refresh loop)', async () => {
    const provider = gmail(testConfig);

    let tokenExchangeCount = 0;
    let sendAttemptCount = 0;

    mockFetchHandler((url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        tokenExchangeCount++;
        return Response.json(
          {
            access_token: `ya29.token_${tokenExchangeCount}`,
            expires_in: 3600,
          },
          { status: 200 }
        );
      }

      if (url.includes('gmail.googleapis.com/gmail/v1/users/me/messages/send')) {
        sendAttemptCount++;
        return Response.json(
          {
            error: {
              code: 401,
              message: 'Invalid Credentials (persistent)',
              status: 'UNAUTHENTICATED',
            },
          },
          { status: 401 }
        );
      }

      return new Response('Not Found', { status: 404 });
    });

    const result = await provider.send(sampleEmail);

    // Exactly 2 token requests and 2 send attempts (1 initial + 1 retry)
    expect(tokenExchangeCount).toBe(2);
    expect(sendAttemptCount).toBe(2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('Invalid Credentials');
    }
  });

  it.each([
    [429, 'Rate Limit Exceeded', true],
    [500, 'Backend Error', true],
    [502, 'Bad Gateway', true],
    [503, 'Service Unavailable', true],
    [504, 'Gateway Timeout', true],
  ])('maps HTTP %d on messages/send to retryable: true', async (status, message, expectedRetryable) => {
    const provider = gmail(testConfig);

    mockFetchHandler((url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'ya29.token_status_test', expires_in: 3600 }, { status: 200 });
      }
      if (url.includes('gmail.googleapis.com/gmail/v1/users/me/messages/send')) {
        return Response.json(
          {
            error: {
              code: status,
              message,
            },
          },
          { status }
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    const result = await provider.send(sampleEmail);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(expectedRetryable);
      expect(result.error).toContain(message);
    }
  });

  it.each([
    [400, 'Invalid recipient address', false],
    [403, 'Insufficient Permission: scope missing', false],
  ])('maps HTTP %d to non-retryable with Google error message', async (status, message, expectedRetryable) => {
    const provider = gmail(testConfig);

    mockFetchHandler((url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'ya29.token_status_test', expires_in: 3600 }, { status: 200 });
      }
      if (url.includes('gmail.googleapis.com/gmail/v1/users/me/messages/send')) {
        return Response.json(
          {
            error: {
              code: status,
              message,
            },
          },
          { status }
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    const result = await provider.send(sampleEmail);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(expectedRetryable);
      expect(result.error).toContain(message);
    }
  });

  it('maps network errors (thrown fetch) to retryable: true', async () => {
    const provider = gmail(testConfig);

    fetchSpy.mockImplementation(((url: RequestInfo | URL) => {
      const urlStr = url instanceof Request ? url.url : String(url);
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve(Response.json({ access_token: 'ya29.net_token', expires_in: 3600 }));
      }
      return Promise.reject(new Error('Connection reset by peer'));
    }) as unknown as typeof fetch);

    const result = await provider.send(sampleEmail);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('Connection reset by peer');
    }
  });

  it('integrates with createMessaging and records sent attempt status', async () => {
    const provider = gmail(testConfig);

    mockFetchHandler((url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'ya29.messaging_token', expires_in: 3600 }, { status: 200 });
      }
      if (url.includes('gmail.googleapis.com/gmail/v1/users/me/messages/send')) {
        return Response.json({ id: 'gmail_pipeline_001' }, { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const templates = defineTemplates({
      alert: {
        kind: 'notification',
        email: {
          subject: () => 'System Alert',
          text: () => 'System update completed.',
        },
      },
    });

    const messaging = createMessaging(newEnv(), {
      templates,
      providers: () => ({ email: provider }),
      delivery: { fallback: ['email'], always: [] },
    });

    const { id } = await messaging.send({
      template: 'alert',
      to: '+10000000000',
      email: 'user@example.com',
      locale: 'en',
      input: undefined,
    });

    const record = await messaging.status(id);
    expect(record).not.toBeNull();
    expect(record!.chain.attempts).toHaveLength(1);
    expect(record!.chain.attempts[0]).toMatchObject({
      channel: 'email',
      provider: 'gmail',
      providerId: 'gmail_pipeline_001',
      status: 'sent',
    });
  });

  it('is not present in the root bundle exports', async () => {
    const root = await import('../../src/index.js');
    expect((root as Record<string, unknown>).gmail).toBeUndefined();
  });

  it('is not reachable from other entry points when unused in built output', () => {
    const distProvidersDir = path.join(rootDir, 'dist/providers');
    if (!fs.existsSync(distProvidersDir)) {
      return; // dist not built yet in pure red phase
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as {
      exports: Record<string, { import: string }>;
    };

    const roots = Object.entries(pkg.exports)
      .filter(([key]) => key !== './providers/*')
      .map(([, target]) => path.join(rootDir, target.import));

    const reachable = walkImportGraph(roots);
    const offenders = [...reachable].filter((file) =>
      file.includes(path.join('providers', 'gmail') + path.sep)
    );
    expect(offenders).toEqual([]);
  });
});
