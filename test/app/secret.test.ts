/**
 * Tests for the shared-secret guard on /send and /status/:id: `createMessagingApp({ secret })`
 * and `createMessagingClient({ secret })`.
 */

import type { ExecutionContext, Fetcher } from '@cloudflare/workers-types';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createMessagingApp, SECRET_HEADER } from '../../src/app/hono.js';
import { createMessagingClient } from '../../src/client/index.js';
import type { MessagingEnv } from '../../src/env.js';
import type { RenderedSms } from '../../src/providers/types.js';
import { defineTemplates } from '../../src/templates.js';
import { memoryKV, recordingProvider, TEST_ENC_KEY } from '../helpers/messaging.js';
import { createMockExecutionContext } from '../helpers/webhook.js';

const SECRET = 'correct horse battery staple';

const templates = defineTemplates({
  ping: { input: z.object({}), kind: 'notification', sms: () => 'ping' },
});

type Env = MessagingEnv & { MESSAGING_SECRET?: string };

function setup(env?: Env) {
  const bindings: Env = env ?? { MESSAGES_KV: memoryKV(), MESSAGING_SECRET: SECRET };
  const app = createMessagingApp<Env>({
    templates,
    providers: () => ({ sms: recordingProvider<RenderedSms>('sms', 'rec-sms') }),
    delivery: { fallback: ['sms'], always: [] },
    secret: (e) => e.MESSAGING_SECRET,
  });
  const fetchApp = (request: Request): Promise<Response> =>
    Promise.resolve(
      app.fetch(request, bindings, createMockExecutionContext() as unknown as ExecutionContext)
    );
  return fetchApp;
}

function sendRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://worker.local/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ template: 'ping', to: '+14155550123', locale: 'en', input: {} }),
  });
}

describe('createMessagingApp secret', () => {
  it('rejects /send with no secret header', async () => {
    const fetchApp = setup();
    const response = await fetchApp(sendRequest());
    expect(response.status).toBe(401);
  });

  it('rejects /send with a wrong secret, including a prefix of the right one', async () => {
    const fetchApp = setup();
    const wrong = await fetchApp(sendRequest({ [SECRET_HEADER]: 'nope' }));
    expect(wrong.status).toBe(401);
    const prefix = SECRET.slice(0, 5);
    const partial = await fetchApp(sendRequest({ [SECRET_HEADER]: prefix }));
    expect(partial.status).toBe(401);
  });

  it('accepts /send and /status/:id with the right secret, and guards /status/:id too', async () => {
    const fetchApp = setup();
    const sent = await fetchApp(sendRequest({ [SECRET_HEADER]: SECRET }));
    expect(sent.status).toBe(200);
    const { id } = (await sent.json()) as { id: string };

    const open = await fetchApp(new Request(`https://worker.local/status/${id}`));
    expect(open.status).toBe(401);

    const authed = await fetchApp(
      new Request(`https://worker.local/status/${id}`, { headers: { [SECRET_HEADER]: SECRET } })
    );
    expect(authed.status).toBe(200);
  });

  it('fails closed with 500 when the secret function returns nothing', async () => {
    const fetchApp = setup({ MESSAGES_KV: memoryKV() });
    const response = await fetchApp(sendRequest({ [SECRET_HEADER]: '' }));
    expect(response.status).toBe(500);
  });

  it('leaves webhook routes public', async () => {
    const fetchApp = setup();
    // No provider called "nobody": the route is reached (404 from the dispatcher), not 401.
    const response = await fetchApp(
      new Request('https://worker.local/webhooks/nobody', { method: 'POST', body: '{}' })
    );
    expect(response.status).toBe(404);
  });

  it('createMessagingClient sends the secret on send() and status()', async () => {
    const fetchApp = setup({
      MESSAGES_KV: memoryKV(),
      MESSAGING_SECRET: SECRET,
      MESSAGES_ENC_KEY: TEST_ENC_KEY,
    });
    const binding = {
      fetch: (input: string, init?: RequestInit) => fetchApp(new Request(input, init)),
    } as unknown as Fetcher;

    const client = createMessagingClient<typeof templates>({ binding, secret: SECRET });
    const result = await client.send('ping', { to: '+14155550123', locale: 'en', input: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await client.status(result.id)).not.toBeNull();

    const anonymous = createMessagingClient<typeof templates>({ binding });
    const refused = await anonymous.send('ping', { to: '+14155550123', locale: 'en', input: {} });
    expect(refused).toMatchObject({ ok: false, status: 401 });
  });
});
