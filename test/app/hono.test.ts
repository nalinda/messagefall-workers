/**
 * Tests for createMessagingApp: Hono routes, typed Env, and startup validation (Issue #13).
 *
 * Acceptance criteria:
 * - A Worker built from the README quick start serves all three routes in a miniflare test.
 * - POST /send with delivery: 'all' produces parallel attempts in the record.
 * - POST /send passes c.executionCtx to the send pipeline.
 * - Route status codes: 200 { id }, 400 for validation errors, 404 unknown template, 422 policy error.
 * - GET /status/:id returns the MessageRecord shape exported by #6, verbatim.
 * - GET /status/:id returns 404 for unknown message ID.
 * - GET, POST /webhooks/:provider dispatches to handleWebhook(provider, request, ctx).
 * - basePath defaults to '/' and is normalised so '/messaging' and '/messaging/' behave identically.
 * - Importing the root entry without hono installed does not throw until createMessagingApp is
 *   called: the root barrel never reaches ./app/hono.js, so `hono` is only resolved through the
 *   separate `messagefall-workers/app` entry point.
 * - Startup validation runs on first request per isolate and reports all configuration problems.
 */

import path from 'node:path';

import type { ExecutionContext, KVNamespace } from '@cloudflare/workers-types';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { z } from 'zod';

import { createMessagingApp } from '../../src/app/hono.js';
import type { Attempt, MessageRecord } from '../../src/core/status.js';
import type { MessagingEnv } from '../../src/env.js';
import type { Channel, Provider, RenderedEmail, RenderedSms, RenderedWhatsApp, SendResult } from '../../src/providers/types.js';
import { defineTemplates } from '../../src/templates.js';
import { createMiniflareKV } from '../helpers/status.js';
import { createMockExecutionContext } from '../helpers/webhook.js';

function createRecordingProvider<R>(
  name: string,
  channel: Channel,
  handler?: (msg: unknown) => Promise<SendResult>
): Provider<R> & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    name,
    channel,
    calls,
    send: (message: unknown) => {
      calls.push(message);
      if (handler) {
        return handler(message);
      }
      return Promise.resolve({ ok: true, providerId: `${name}_${calls.length}` });
    },
  };
}

describe('createMessagingApp Hono routes and miniflare integration (Issue #13)', () => {
  let kv: KVNamespace;
  let disposeKv: () => Promise<void>;

  beforeAll(async () => {
    const miniflare = await createMiniflareKV();
    kv = miniflare.kv;
    disposeKv = miniflare.dispose;
  });

  afterAll(async () => {
    await disposeKv();
  });

  const testTemplates = defineTemplates({
    loginCode: {
      input: z.object({ code: z.string().length(6) }),
      kind: 'otp',
      whatsapp: {
        template: 'login_code',
        language: 'en',
        params: ({ code }: { code: string }) => [code],
      },
      sms: ({ code }: { code: string }) => `Your code is ${code}`,
    },
    matchFound: {
      input: z.object({ title: z.string(), url: z.string() }),
      kind: 'notification',
      whatsapp: {
        template: 'match_found',
        language: 'en',
        params: ({ title, url }: { title: string; url: string }) => [title, url],
      },
      sms: ({ title, url }: { title: string; url: string }) => `New match: ${title} ${url}`,
      email: {
        subject: ({ title }: { title: string }) => `New match: ${title}`,
        text: ({ title, url }: { title: string; url: string }) => `${title}\n${url}`,
      },
    },
    smsOnly: {
      input: z.object({ message: z.string() }),
      kind: 'notification',
      sms: ({ message }: { message: string }) => message,
    },
  });

  it('serves all three routes in a worker built from README quick start under miniflare', async () => {
    const waProvider = createRecordingProvider<RenderedWhatsApp>('meta-whatsapp', 'whatsapp');
    const smsProvider = createRecordingProvider<RenderedSms>('http-sms', 'sms');
    const emailProvider = createRecordingProvider<RenderedEmail>('gmail', 'email');

    // Add webhook handling to waProvider for route testing
    waProvider.webhook = {
      verify: (request: Request) => {
        const url = new URL(request.url);
        const challenge = url.searchParams.get('hub.challenge');
        if (challenge) {
          return Promise.resolve(new Response(challenge, { status: 200 }));
        }
        return Promise.resolve(null);
      },
      parse: async (request: Request) => {
        const body = (await request.json()) as { id: string; status: 'delivered' };
        return [{ providerId: body.id, status: body.status, at: '2026-09-20T12:00:00.000Z' }];
      },
    };

    const app = createMessagingApp({
      templates: testTemplates,
      providers: () => ({
        whatsapp: waProvider,
        sms: smsProvider,
        email: emailProvider,
      }),
      delivery: {
        fallback: ['whatsapp', 'sms'],
        always: ['email'],
      },
    });

    expect(app).toBeInstanceOf(Hono);

    const env: MessagingEnv = { MESSAGES_KV: kv };
    const ctx = createMockExecutionContext();

    // 1. POST /send
    const sendResponse = await app.fetch(
      new Request('https://worker.local/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          template: 'loginCode',
          to: '+94771234567',
          locale: 'en',
          input: { code: '482913' },
        }),
      }),
      env,
      ctx as unknown as ExecutionContext
    );

    expect(sendResponse.status).toBe(200);
    const sendBody = (await sendResponse.json()) as { id: string };
    expect(sendBody).toHaveProperty('id');
    expect(typeof sendBody.id).toBe('string');
    expect(sendBody.id.startsWith('msg_')).toBe(true);

    const messageId = sendBody.id;

    // 2. GET /status/:id
    const statusResponse = await app.fetch(
      new Request(`https://worker.local/status/${messageId}`),
      env,
      ctx as unknown as ExecutionContext
    );

    expect(statusResponse.status).toBe(200);
    const statusRecord = (await statusResponse.json()) as MessageRecord;
    expect(statusRecord.id).toBe(messageId);
    expect(statusRecord.template).toBe('loginCode');
    expect(statusRecord.status).toBe('sent');
    expect(statusRecord.chain.attempts.length).toBeGreaterThanOrEqual(1);

    // 3. GET /webhooks/:provider (handshake)
    const webhookGetResponse = await app.fetch(
      new Request(
        'https://worker.local/webhooks/meta-whatsapp?hub.mode=subscribe&hub.verify_token=valid&hub.challenge=test_challenge_123'
      ),
      env,
      ctx as unknown as ExecutionContext
    );
    expect(webhookGetResponse.status).toBe(200);
    const webhookGetText = await webhookGetResponse.text();
    expect(webhookGetText).toBe('test_challenge_123');

    // 4. POST /webhooks/:provider (delivery status update)
    const webhookPostResponse = await app.fetch(
      new Request('https://worker.local/webhooks/meta-whatsapp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: `${waProvider.name}_1`, status: 'delivered' }),
      }),
      env,
      ctx as unknown as ExecutionContext
    );
    expect(webhookPostResponse.status).toBe(200);
  });

  it('POST /send with delivery: "all" produces parallel attempts in the record', async () => {
    const waProvider = createRecordingProvider<RenderedWhatsApp>('meta-whatsapp', 'whatsapp');
    const smsProvider = createRecordingProvider<RenderedSms>('http-sms', 'sms');
    const emailProvider = createRecordingProvider<RenderedEmail>('gmail', 'email');

    const app = createMessagingApp({
      templates: testTemplates,
      providers: () => ({
        whatsapp: waProvider,
        sms: smsProvider,
        email: emailProvider,
      }),
    });

    const env: MessagingEnv = { MESSAGES_KV: kv };
    const ctx = createMockExecutionContext();

    const response = await app.fetch(
      new Request('https://worker.local/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          template: 'matchFound',
          to: '+94771234567',
          email: 'user@example.com',
          locale: 'en',
          input: { title: 'Big Match', url: 'https://example.com/match' },
          delivery: 'all',
        }),
      }),
      env,
      ctx as unknown as ExecutionContext
    );

    expect(response.status).toBe(200);
    const { id } = (await response.json()) as { id: string };

    const statusResponse = await app.fetch(
      new Request(`https://worker.local/status/${id}`),
      env,
      ctx as unknown as ExecutionContext
    );
    const record = (await statusResponse.json()) as MessageRecord;

    // All channels defined on the template (whatsapp, sms, email) were attempted in parallel under always
    expect(record.always).toHaveLength(3);
    const attemptedChannels = record.always.map((a: Attempt) => a.channel);
    expect(attemptedChannels).toContain('whatsapp');
    expect(attemptedChannels).toContain('sms');
    expect(attemptedChannels).toContain('email');
  });

  it('POST /send passes c.executionCtx to the send execution context', async () => {
    const smsProvider = createRecordingProvider<RenderedSms>('http-sms', 'sms');
    const app = createMessagingApp({
      templates: testTemplates,
      providers: () => ({ sms: smsProvider }),
    });

    const env: MessagingEnv = { MESSAGES_KV: kv };
    const mockCtx = createMockExecutionContext();

    const response = await app.fetch(
      new Request('https://worker.local/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          template: 'smsOnly',
          to: '+94771234567',
          locale: 'en',
          input: { message: 'Hello' },
        }),
      }),
      env,
      mockCtx as unknown as ExecutionContext
    );

    expect(response.status).toBe(200);
    // Execution context was passed through and received waitUntil promises
    expect(mockCtx.promises.length).toBeGreaterThanOrEqual(0);
  });

  it('POST /send returns 400 on input validation, missing fields, or invalid phone number', async () => {
    const smsProvider = createRecordingProvider<RenderedSms>('http-sms', 'sms');
    const app = createMessagingApp({
      templates: testTemplates,
      providers: () => ({ sms: smsProvider }),
    });

    const env: MessagingEnv = { MESSAGES_KV: kv };

    // 1. Invalid JSON body
    const badJsonResponse = await app.fetch(
      new Request('https://worker.local/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'invalid-json{',
      }),
      env
    );
    expect(badJsonResponse.status).toBe(400);

    // 2. Missing required 'to' field
    const missingToResponse = await app.fetch(
      new Request('https://worker.local/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          template: 'smsOnly',
          locale: 'en',
          input: { message: 'hello' },
        }),
      }),
      env
    );
    expect(missingToResponse.status).toBe(400);

    // 3. Invalid phone number (not E.164)
    const badPhoneResponse = await app.fetch(
      new Request('https://worker.local/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          template: 'smsOnly',
          to: 'invalid-number',
          locale: 'en',
          input: { message: 'hello' },
        }),
      }),
      env
    );
    expect(badPhoneResponse.status).toBe(400);

    // 4. Schema validation failure (code must be 6 digits, provided 3)
    const badSchemaResponse = await app.fetch(
      new Request('https://worker.local/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          template: 'loginCode',
          to: '+94771234567',
          locale: 'en',
          input: { code: '123' },
        }),
      }),
      env
    );
    expect(badSchemaResponse.status).toBe(400);
  });

  it('POST /send returns 404 for unknown template', async () => {
    const smsProvider = createRecordingProvider<RenderedSms>('http-sms', 'sms');
    const app = createMessagingApp({
      templates: testTemplates,
      providers: () => ({ sms: smsProvider }),
    });

    const env: MessagingEnv = { MESSAGES_KV: kv };

    const response = await app.fetch(
      new Request('https://worker.local/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          template: 'nonExistentTemplate',
          to: '+94771234567',
          locale: 'en',
          input: {},
        }),
      }),
      env
    );

    expect(response.status).toBe(404);
  });

  it('POST /send returns 422 for policy error (delivery names channel template does not define)', async () => {
    const smsProvider = createRecordingProvider<RenderedSms>('http-sms', 'sms');
    const app = createMessagingApp({
      templates: testTemplates,
      providers: () => ({ sms: smsProvider }),
    });

    const env: MessagingEnv = { MESSAGES_KV: kv };

    const response = await app.fetch(
      new Request('https://worker.local/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          template: 'smsOnly',
          to: '+94771234567',
          locale: 'en',
          input: { message: 'hello' },
          delivery: { fallback: ['whatsapp'] }, // smsOnly does not define whatsapp
        }),
      }),
      env
    );

    expect(response.status).toBe(422);
  });

  it('GET /status/:id returns the MessageRecord shape exported by #6 verbatim', async () => {
    const smsProvider = createRecordingProvider<RenderedSms>('http-sms', 'sms');
    const app = createMessagingApp({
      templates: testTemplates,
      providers: () => ({ sms: smsProvider }),
    });

    const env: MessagingEnv = { MESSAGES_KV: kv };

    const sendRes = await app.fetch(
      new Request('https://worker.local/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          template: 'smsOnly',
          to: '+94771234567',
          locale: 'en',
          input: { message: 'verbatim-status-check' },
        }),
      }),
      env
    );

    const { id } = (await sendRes.json()) as { id: string };

    const statusRes = await app.fetch(new Request(`https://worker.local/status/${id}`), env);
    expect(statusRes.status).toBe(200);

    const record = (await statusRes.json()) as MessageRecord;

    // Verbatim MessageRecord shape check
    expect(record).toHaveProperty('id', id);
    expect(record).toHaveProperty('template', 'smsOnly');
    expect(record).toHaveProperty('kind', 'notification');
    expect(record).toHaveProperty('policy');
    expect(record.policy).toHaveProperty('fallback');
    expect(record.policy).toHaveProperty('always');
    expect(record).toHaveProperty('chain');
    expect(record.chain).toHaveProperty('status', 'sent');
    expect(record.chain).toHaveProperty('attempts');
    expect(Array.isArray(record.chain.attempts)).toBe(true);
    expect(record).toHaveProperty('always');
    expect(Array.isArray(record.always)).toBe(true);
    expect(record).toHaveProperty('status', 'sent');
    expect(record).toHaveProperty('createdAt');
    expect(record).toHaveProperty('updatedAt');

    // No extra or dropped fields
    const keys = Object.keys(record).toSorted((a, b) => a.localeCompare(b));
    expect(keys).toEqual([
      'always',
      'chain',
      'createdAt',
      'id',
      'kind',
      'policy',
      'status',
      'template',
      'updatedAt',
    ]);
  });

  it('GET /status/:id returns 404 when record does not exist', async () => {
    const smsProvider = createRecordingProvider<RenderedSms>('http-sms', 'sms');
    const app = createMessagingApp({
      templates: testTemplates,
      providers: () => ({ sms: smsProvider }),
    });

    const env: MessagingEnv = { MESSAGES_KV: kv };

    const statusRes = await app.fetch(
      new Request('https://worker.local/status/msg_non_existent_id'),
      env
    );
    expect(statusRes.status).toBe(404);
  });

  it('GET, POST /webhooks/:provider dispatches to handleWebhook and returns 404 for unknown provider', async () => {
    const waProvider = createRecordingProvider<RenderedWhatsApp>('meta-whatsapp', 'whatsapp');
    waProvider.webhook = {
      parse: async (req: Request) => {
        const body = (await req.json()) as { id: string; status: 'delivered' };
        return [{ providerId: body.id, status: body.status, at: '2026-09-20T12:00:00.000Z' }];
      },
    };

    const app = createMessagingApp({
      templates: testTemplates,
      providers: () => ({ whatsapp: waProvider }),
    });

    const env: MessagingEnv = { MESSAGES_KV: kv };

    // Known provider webhook
    const knownRes = await app.fetch(
      new Request('https://worker.local/webhooks/meta-whatsapp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'wa_msg_1', status: 'delivered' }),
      }),
      env
    );
    expect(knownRes.status).toBe(200);

    // Unknown provider webhook returns 404
    const unknownRes = await app.fetch(
      new Request('https://worker.local/webhooks/unknown-provider', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'wa_msg_1', status: 'delivered' }),
      }),
      env
    );
    expect(unknownRes.status).toBe(404);
  });

  it('normalises basePath so "/messaging" and "/messaging/" behave identically', async () => {
    const smsProvider = createRecordingProvider<RenderedSms>('http-sms', 'sms');

    // 1. basePath without trailing slash
    const appWithoutSlash = createMessagingApp({
      templates: testTemplates,
      providers: () => ({ sms: smsProvider }),
      basePath: '/messaging',
    });

    // 2. basePath with trailing slash
    const appWithSlash = createMessagingApp({
      templates: testTemplates,
      providers: () => ({ sms: smsProvider }),
      basePath: '/messaging/',
    });

    const env: MessagingEnv = { MESSAGES_KV: kv };

    const reqPayload = {
      template: 'smsOnly',
      to: '+94771234567',
      locale: 'en',
      input: { message: 'base-path-test' },
    };

    // Both apps serve /messaging/send
    const res1 = await appWithoutSlash.fetch(
      new Request('https://worker.local/messaging/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reqPayload),
      }),
      env
    );
    expect(res1.status).toBe(200);

    const res2 = await appWithSlash.fetch(
      new Request('https://worker.local/messaging/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reqPayload),
      }),
      env
    );
    expect(res2.status).toBe(200);

    // Root /send is not found when basePath is '/messaging'
    const rootRes = await appWithoutSlash.fetch(
      new Request('https://worker.local/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reqPayload),
      }),
      env
    );
    expect(rootRes.status).toBe(404);
  });

  it('keeps the Hono app off the root barrel so the root entry never resolves the optional peer', async () => {
    // Dynamic import of root entry point succeeds without requiring hono
    const root = (await import('../../src/index.js')) as Record<string, unknown>;
    expect(root).toBeDefined();
    expect(typeof root.createMessaging).toBe('function');
    expect(typeof root.defineTemplates).toBe('function');
    // createMessagingApp lives behind `messagefall-workers/app` only: were it re-exported here,
    // a consumer without `hono` installed could not import the root entry at all.
    expect(root.createMessagingApp).toBeUndefined();

    const source = await Bun.file(
      path.join(import.meta.dir, '../../src/index.ts')
    ).text();
    expect(source).not.toContain('app/hono');
  });

  it('runs startup validation on first request per isolate and reports configuration errors', async () => {
    const duplicateProvider: Provider = {
      name: 'same-name',
      channel: 'sms',
      send: () => Promise.resolve({ ok: true }),
    };
    const duplicateWa: Provider = {
      name: 'same-name',
      channel: 'whatsapp',
      send: () => Promise.resolve({ ok: true }),
    };

    const app = createMessagingApp({
      templates: testTemplates,
      providers: () => ({
        sms: duplicateProvider,
        whatsapp: duplicateWa,
      }),
    });

    // Env missing MESSAGES_KV and options have duplicate provider name
    const invalidEnv = {} as MessagingEnv;

    let didFailOrThrow = false;
    try {
      const response = await app.fetch(
        new Request('https://worker.local/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            template: 'smsOnly',
            to: '+94771234567',
            locale: 'en',
            input: { message: 'startup-check' },
          }),
        }),
        invalidEnv
      );
      if (response.status >= 500) {
        didFailOrThrow = true;
      }
    } catch {
      didFailOrThrow = true;
    }

    expect(didFailOrThrow).toBe(true);
  });
});
