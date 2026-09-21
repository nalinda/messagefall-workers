/**
 * Tests for the Meta WhatsApp Cloud API provider's webhook (Issue #4).
 *
 * Acceptance criteria covered:
 * - Handshake success and failure.
 * - A signed status payload parses to the expected events.
 * - A bad signature and a missing header throw.
 * - A message-received payload yields [].
 */

import { describe, expect, it } from 'bun:test';

import { metaWhatsApp } from '../../../src/providers/meta-whatsapp/index.js';
import type { Provider, RenderedWhatsApp } from '../../../src/providers/types.js';
import { rejectionOf, signBody, testConfig } from './fixtures.js';

const WEBHOOK_URL = 'https://example.com/webhooks/meta-whatsapp';

function handshake(params: Record<string, string>): Request {
  const url = new URL(WEBHOOK_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url.href);
}

const METADATA = { display_phone_number: '15550001111', phone_number_id: '123456789012345' };

/**
 * Statuses are spread across two `changes` in the first entry and a second
 * `entry`, so an implementation that only reads `entry[0].changes[0]` cannot
 * produce the expected output: the walk must flatten `entry[].changes[]`.
 */
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
              metadata: METADATA,
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
              ],
            },
          },
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: METADATA,
              statuses: [
                {
                  id: 'wamid.READ1',
                  status: 'read',
                  timestamp: '1700000020',
                  recipient_id: '94771234567',
                },
              ],
            },
          },
        ],
      },
      {
        id: 'WABA_ID_2',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: METADATA,
              statuses: [
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

function unsignedRequest(body: string): Request {
  return new Request(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('metaWhatsApp provider: webhook', () => {
  const provider: Provider<RenderedWhatsApp> = metaWhatsApp(testConfig);

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
    it('parses a correctly signed status payload into StatusEvent[], flattening entry[].changes[]', async () => {
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

    it.each([
      ['missing', undefined],
      ['non-numeric', 'not-a-timestamp'],
    ])(
      'keeps a status with a %s timestamp and falls back to the receipt time for at',
      async (_label, timestamp) => {
        const status: Record<string, unknown> = {
          id: 'wamid.NOTIME1',
          status: 'failed',
          recipient_id: '94771234567',
          errors: [{ code: 131_026, title: 'Message undeliverable' }],
        };
        if (timestamp !== undefined) status.timestamp = timestamp;
        const payload = {
          object: 'whatsapp_business_account',
          entry: [
            {
              id: 'WABA_ID',
              changes: [
                {
                  field: 'messages',
                  value: { messaging_product: 'whatsapp', metadata: METADATA, statuses: [status] },
                },
              ],
            },
          ],
        };
        const request = await signedRequest(payload, testConfig.appSecret);

        const before = Date.now();
        const events = await webhook().parse(request);
        const after = Date.now();

        expect(events).toHaveLength(1);
        const [event] = events;
        expect(event).toMatchObject({
          providerId: 'wamid.NOTIME1',
          status: 'failed',
          error: 'Message undeliverable',
        });
        const at = Date.parse(event.at);
        expect(Number.isNaN(at)).toBe(false);
        expect(new Date(at).toISOString()).toBe(event.at);
        expect(at).toBeGreaterThanOrEqual(before - 1000);
        expect(at).toBeLessThanOrEqual(after + 1000);
      },
    );

    it('yields [] for a signed message-received (non-status) payload', async () => {
      const request = await signedRequest(messageReceivedPayload(), testConfig.appSecret);

      const events = await webhook().parse(request);

      expect(events).toEqual([]);
    });
  });

  describe('parse (dev bypass)', () => {
    // A vendor webhook cannot reach a developer's machine, so MESSAGING_DEV_UNSIGNED on
    // localhost lets an unsigned payload through — for the reference provider too, not just
    // for console. `devUnsigned` is the one name the dispatcher and every provider use.
    it('parses an unsigned payload when the dispatcher grants devUnsigned', async () => {
      const request = unsignedRequest(JSON.stringify(statusPayload()));

      const events = await webhook().parse(request, { devUnsigned: true });

      const ids = events.map((event) => event.providerId);
      expect(ids).toEqual(['wamid.SENT1', 'wamid.DELIVERED1', 'wamid.READ1', 'wamid.FAILED1']);
    });

    it.each([
      ['devUnsigned: false', { devUnsigned: false }],
      ['no flag set', {}],
      ['no options at all', undefined],
    ])('still enforces the signature with %s', async (_label, parseOptions) => {
      const request = unsignedRequest(JSON.stringify(statusPayload()));

      const error = await rejectionOf(webhook().parse(request, parseOptions));

      expect(error).toBeInstanceOf(Error);
    });

    it('throws on a body that is not JSON even under the bypass', async () => {
      const request = unsignedRequest('not json');

      const error = await rejectionOf(webhook().parse(request, { devUnsigned: true }));

      expect(error).toBeInstanceOf(Error);
    });
  });
});
