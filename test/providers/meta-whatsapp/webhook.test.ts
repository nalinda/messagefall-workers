/**
 * Tests for the Meta WhatsApp Cloud API provider's webhook (Issue #4).
 *
 * Acceptance criteria covered:
 * - Handshake success and failure.
 * - A signed status payload parses to the expected events.
 * - A bad signature and a missing header throw.
 * - A message-received payload yields [].
 */

import { beforeAll, describe, expect, it } from 'bun:test';

import type { Provider, RenderedWhatsApp } from '../../../src/providers/types.js';
import type { MetaWhatsAppFactory } from './load.js';
import { loadMetaWhatsApp, rejectionOf, signBody, testConfig } from './load.js';

const WEBHOOK_URL = 'https://example.com/webhooks/meta-whatsapp';

function handshake(params: Record<string, string>): Request {
  const url = new URL(WEBHOOK_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url.href);
}

function statusPayload(): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: '123456789012345' },
              statuses: [
                {
                  id: 'wamid.SENT1',
                  status: 'sent',
                  timestamp: '1700000000',
                  recipient_id: '94771234567',
                  conversation: { id: 'conv1', origin: { type: 'authentication' } },
                },
                {
                  id: 'wamid.DELIVERED1',
                  status: 'delivered',
                  timestamp: '1700000010',
                  recipient_id: '94771234567',
                },
                {
                  id: 'wamid.READ1',
                  status: 'read',
                  timestamp: '1700000020',
                  recipient_id: '94771234567',
                },
                {
                  id: 'wamid.FAILED1',
                  status: 'failed',
                  timestamp: '1700000030',
                  recipient_id: '94771234567',
                  errors: [
                    {
                      code: 131_026,
                      title: 'Message undeliverable',
                      message: 'Message undeliverable.',
                      error_data: { details: 'Recipient is not a valid WhatsApp user' },
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function messageReceivedPayload(): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: '123456789012345' },
              contacts: [{ profile: { name: 'Nalinda' }, wa_id: '94771234567' }],
              messages: [
                {
                  from: '94771234567',
                  id: 'wamid.INBOUND1',
                  timestamp: '1700000100',
                  type: 'text',
                  text: { body: 'hello' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function signedRequest(
  payload: unknown,
  secret: string,
  headerOverride?: Record<string, string> | null,
): Promise<Request> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (headerOverride === undefined) {
    headers['x-hub-signature-256'] = await signBody(body, secret);
  } else if (headerOverride !== null) {
    Object.assign(headers, headerOverride);
  }
  return new Request(WEBHOOK_URL, { method: 'POST', headers, body });
}

describe('metaWhatsApp provider: webhook', () => {
  let metaWhatsApp: MetaWhatsAppFactory;
  let provider: Provider<RenderedWhatsApp>;

  beforeAll(async () => {
    metaWhatsApp = await loadMetaWhatsApp();
    provider = metaWhatsApp(testConfig);
  });

  function webhook(): NonNullable<Provider<RenderedWhatsApp>['webhook']> {
    if (!provider.webhook) throw new Error('provider.webhook is not defined');
    return provider.webhook;
  }

  function verify(request: Request): Promise<Response | null> {
    const hooks = webhook();
    if (!hooks.verify) throw new Error('provider.webhook.verify is not defined');
    return hooks.verify(request);
  }

  describe('verify (GET handshake)', () => {
    it('returns 200 with hub.challenge as text when hub.mode=subscribe and the verify token matches', async () => {
      const response = await verify(
        handshake({
          'hub.mode': 'subscribe',
          'hub.verify_token': testConfig.verifyToken,
          'hub.challenge': '1158201444',
        }),
      );

      expect(response).not.toBeNull();
      expect(response?.status).toBe(200);
      expect(await response?.text()).toBe('1158201444');
    });

    it('returns 403 when the verify token does not match', async () => {
      const response = await verify(
        handshake({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong-token',
          'hub.challenge': '1158201444',
        }),
      );

      expect(response).not.toBeNull();
      expect(response?.status).toBe(403);
      expect(await response?.text()).not.toBe('1158201444');
    });

    it('returns 403 when hub.mode is not subscribe', async () => {
      const response = await verify(
        handshake({
          'hub.mode': 'unsubscribe',
          'hub.verify_token': testConfig.verifyToken,
          'hub.challenge': '1158201444',
        }),
      );

      expect(response).not.toBeNull();
      expect(response?.status).toBe(403);
    });

    it('returns null for non-GET requests so parse handles them', async () => {
      const request = await signedRequest(statusPayload(), testConfig.appSecret);
      const response = await verify(request);
      expect(response).toBeNull();
    });
  });

  describe('parse (signed POST)', () => {
    it('parses a correctly signed status payload into StatusEvent[]', async () => {
      const request = await signedRequest(statusPayload(), testConfig.appSecret);

      const events = await webhook().parse(request);

      expect(events).toEqual([
        { providerId: 'wamid.SENT1', status: 'sent', at: new Date(1_700_000_000_000).toISOString() },
        {
          providerId: 'wamid.DELIVERED1',
          status: 'delivered',
          at: new Date(1_700_000_010_000).toISOString(),
        },
        { providerId: 'wamid.READ1', status: 'read', at: new Date(1_700_000_020_000).toISOString() },
        {
          providerId: 'wamid.FAILED1',
          status: 'failed',
          error: 'Message undeliverable',
          at: new Date(1_700_000_030_000).toISOString(),
        },
      ]);
    });

    it('throws when the signature does not match the body', async () => {
      const request = await signedRequest(statusPayload(), 'a-different-secret');

      expect(await rejectionOf(webhook().parse(request))).toBeInstanceOf(Error);
    });

    it('throws when the signature header is well-formed but for a different body', async () => {
      const original = JSON.stringify(statusPayload());
      const signature = await signBody(original, testConfig.appSecret);
      const request = new Request(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
        body: original.replace('wamid.SENT1', 'wamid.FORGED'),
      });

      expect(await rejectionOf(webhook().parse(request))).toBeInstanceOf(Error);
    });

    it('throws when the X-Hub-Signature-256 header is missing', async () => {
      const request = await signedRequest(statusPayload(), testConfig.appSecret, null);

      expect(await rejectionOf(webhook().parse(request))).toBeInstanceOf(Error);
    });

    it('throws when the header lacks the sha256= prefix', async () => {
      const body = JSON.stringify(statusPayload());
      const signature = await signBody(body, testConfig.appSecret);
      const bare = signature.replace('sha256=', '');
      const request = await signedRequest(statusPayload(), testConfig.appSecret, {
        'x-hub-signature-256': bare,
      });

      expect(await rejectionOf(webhook().parse(request))).toBeInstanceOf(Error);
    });

    it('yields [] for a signed message-received (non-status) payload', async () => {
      const request = await signedRequest(messageReceivedPayload(), testConfig.appSecret);

      const events = await webhook().parse(request);

      expect(events).toEqual([]);
    });
  });
});
