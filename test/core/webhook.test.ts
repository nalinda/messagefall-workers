/**
 * Failing tests for Webhook dispatch: /webhooks/:provider routed to the provider's handler (GitHub Issue #5).
 *
 * Acceptance criteria:
 * - Tests: unknown provider; provider without webhook; `verify` returning a response short-circuits;
 *   a parsed `delivered` event updates the correct attempt and overall status; `parse` throwing returns `401`;
 *   an unknown provider id is acknowledged with `200`.
 * - `StatusApplied` is emitted only for chain attempts.
 * - The dev bypass works on a `localhost` URL and is refused on any other host.
 */

import type { ExecutionContext, KVNamespace } from '@cloudflare/workers-types';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { kvStatusStore, type MessageRecord } from '../../src/core/status.js';
import {
  createWebhookHandler,
  type StatusApplied,
  type WebhookHandler,
} from '../../src/core/webhook.js';
import type {
  DeliveryStatus,
  Provider,
  StatusEvent,
  WebhookParseOptions,
} from '../../src/providers/types.js';
import { captureConsole } from '../helpers/messaging.js';
import { createMiniflareKV } from '../helpers/status.js';
import { createMockExecutionContext, type MockExecutionContext } from '../helpers/webhook.js';

function createSignedProvider(): Provider {
  return {
    name: 'meta-wa',
    channel: 'whatsapp',
    send: () => Promise.resolve({ ok: true }),
    webhook: {
      parse: async (
        req: Request,
        parseOpts?: WebhookParseOptions
      ): Promise<StatusEvent[]> => {
        const sig = req.headers.get('x-hub-signature-256');
        if (sig !== 'sha256=valid_test_signature' && parseOpts?.devUnsigned !== true) {
          throw new Error('Signature validation failed');
        }

        const body = (await req.json()) as { id: string; status: DeliveryStatus };
        return [
          {
            providerId: body.id,
            status: body.status,
            at: '2026-09-20T12:00:00.000Z',
          },
        ];
      },
    },
  };
}

/**
 * A single-attempt record for the redaction tests, where the `in:<id>` render input has expired
 * and the only way back to the rendered content is the template definition.
 */
function singleAttemptRecord(
  messageId: string,
  providerId: string,
  template: string,
  channel: 'whatsapp' | 'email',
  provider: string
): MessageRecord {
  return {
    id: messageId,
    template,
    kind: 'otp',
    policy: { fallback: [channel], always: [] },
    chain: {
      status: 'sent',
      attempts: [
        {
          channel,
          provider,
          providerId,
          status: 'sent',
          at: '2026-09-20T12:00:00.000Z',
        },
      ],
    },
    always: [],
    status: 'sent',
    createdAt: '2026-09-20T12:00:00.000Z',
    updatedAt: '2026-09-20T12:00:00.000Z',
  };
}

function providerEmitting(name: string, event: StatusEvent): Provider {
  return {
    name,
    channel: 'whatsapp',
    send: () => Promise.resolve({ ok: true }),
    webhook: {
      parse: () => Promise.resolve([event]),
    },
  };
}

describe('Issue #5: Webhook dispatch: /webhooks/:provider routed to provider handler', () => {
  let kv: KVNamespace;
  let disposeKv: () => Promise<void>;

  beforeEach(async () => {
    const miniflareEnv = await createMiniflareKV();
    kv = miniflareEnv.kv;
    disposeKv = miniflareEnv.dispose;
  });

  afterEach(async () => {
    await disposeKv();
  });

  describe('Provider Lookup and Routing', () => {
    it('returns 404 when provider name is unknown across configured channels', async () => {
      const provider: Provider = {
        name: 'meta-wa',
        channel: 'whatsapp',
        send: () => Promise.resolve({ ok: true }),
        webhook: {
          parse: () => Promise.resolve([]),
        },
      };

      const handleWebhook: WebhookHandler = createWebhookHandler({
        providers: { whatsapp: provider },
        kv,
      });

      const request = new Request('http://localhost/webhooks/unknown-provider', {
        method: 'POST',
        body: JSON.stringify({ event: 'delivered' }),
        headers: { 'content-type': 'application/json' },
      });

      const response = await handleWebhook('unknown-provider', request);
      expect(response.status).toBe(404);
    });

    it('returns 404 when provider is configured but does not define a webhook property', async () => {
      const providerWithoutWebhook: Provider = {
        name: 'console-sms',
        channel: 'sms',
        send: () => Promise.resolve({ ok: true }),
      };

      const handleWebhook: WebhookHandler = createWebhookHandler({
        providers: { sms: providerWithoutWebhook },
        kv,
      });

      const request = new Request('http://localhost/webhooks/console-sms', {
        method: 'POST',
        body: JSON.stringify({ event: 'delivered' }),
        headers: { 'content-type': 'application/json' },
      });

      const response = await handleWebhook('console-sms', request);
      expect(response.status).toBe(404);
    });
  });

  describe('Webhook Verification Handshake (webhook.verify)', () => {
    it('returns verify Response as-is and short-circuits without calling parse when verify returns non-null', async () => {
      let wasParseCalled = false;

      const providerWithVerify: Provider = {
        name: 'meta-wa',
        channel: 'whatsapp',
        send: () => Promise.resolve({ ok: true }),
        webhook: {
          verify: (req: Request): Promise<Response | null> => {
            const url = new URL(req.url);
            if (url.searchParams.get('hub.mode') === 'subscribe') {
              const challenge = url.searchParams.get('hub.challenge') ?? 'verified';
              return Promise.resolve(
                new Response(challenge, {
                  status: 200,
                  headers: { 'content-type': 'text/plain; charset=utf-8' },
                })
              );
            }
            return Promise.resolve(null);
          },
          parse: (): Promise<StatusEvent[]> => {
            wasParseCalled = true;
            return Promise.resolve([]);
          },
        },
      };

      const handleWebhook = createWebhookHandler({
        providers: { whatsapp: providerWithVerify },
        kv,
      });

      const challengeRequest = new Request(
        'http://localhost/webhooks/meta-wa?hub.mode=subscribe&hub.challenge=challenge_token_abc123'
      );

      const response = await handleWebhook('meta-wa', challengeRequest);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toBe('challenge_token_abc123');
      expect(wasParseCalled).toBe(false);
    });

    it('proceeds to parse when webhook.verify returns null', async () => {
      let wasParseCalled = false;

      const provider: Provider = {
        name: 'meta-wa',
        channel: 'whatsapp',
        send: () => Promise.resolve({ ok: true }),
        webhook: {
          verify: (): Promise<Response | null> => {
            return Promise.resolve(null);
          },
          parse: (): Promise<StatusEvent[]> => {
            wasParseCalled = true;
            return Promise.resolve([]);
          },
        },
      };

      const handleWebhook = createWebhookHandler({
        providers: { whatsapp: provider },
        kv,
      });

      const postRequest = new Request('http://localhost/webhooks/meta-wa', {
        method: 'POST',
        body: JSON.stringify({ id: 'wamid_1' }),
        headers: { 'content-type': 'application/json' },
      });

      const response = await handleWebhook('meta-wa', postRequest);
      expect(response.status).toBe(200);
      expect(wasParseCalled).toBe(true);
    });
  });

  describe('Payload Parsing and Error Handling (webhook.parse)', () => {
    it('returns 401 with no body detail when webhook.parse throws an error', async () => {
      const secretKey = 'super_secret_signing_key_99999';
      const provider: Provider = {
        name: 'meta-wa',
        channel: 'whatsapp',
        send: () => Promise.resolve({ ok: true }),
        webhook: {
          parse: (): Promise<StatusEvent[]> => {
            throw new Error(`Signature mismatch against secret ${secretKey}`);
          },
        },
      };

      const handleWebhook = createWebhookHandler({
        providers: { whatsapp: provider },
        kv,
      });

      const invalidRequest = new Request('http://localhost/webhooks/meta-wa', {
        method: 'POST',
        body: JSON.stringify({ invalid: true }),
        headers: { 'content-type': 'application/json' },
      });

      const response = await handleWebhook('meta-wa', invalidRequest);
      expect(response.status).toBe(401);

      const bodyText = await response.text();
      // Must not leak internal error message or secrets in the 401 body
      expect(bodyText).not.toContain(secretKey);
      expect(bodyText).not.toContain('Signature mismatch');
      expect(bodyText.length).toBeLessThanOrEqual(50);
    });

    it('returns 401 when webhook.parse throws non-Error values', async () => {
      const provider: Provider = {
        name: 'meta-wa',
        channel: 'whatsapp',
        send: () => Promise.resolve({ ok: true }),
        webhook: {
          parse: (): Promise<StatusEvent[]> => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw 'Unauthorized payload';
          },
        },
      };

      const handleWebhook = createWebhookHandler({
        providers: { whatsapp: provider },
        kv,
      });

      const invalidRequest = new Request('http://localhost/webhooks/meta-wa', {
        method: 'POST',
        body: 'invalid',
      });

      const response = await handleWebhook('meta-wa', invalidRequest);
      expect(response.status).toBe(401);
    });
  });

  describe('Status Store Updates for Known Provider IDs', () => {
    it('updates attempt status/error/at, recomputes chain and overall status, and calls onStatus for delivered event', async () => {
      const store = kvStatusStore(kv);

      const messageId = 'msg_01J9DISPATCH000000000001';
      const providerId = 'wamid.HBgL_01J9TEST_DELIVERED';
      const eventTimestamp = '2026-09-20T12:00:05.000Z';

      const initialRecord: MessageRecord = {
        id: messageId,
        template: 'otpVerification',
        kind: 'otp',
        policy: { fallback: ['whatsapp', 'sms'], always: ['email'] },
        chain: {
          status: 'sent',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId,
              status: 'sent',
              at: '2026-09-20T12:00:00.000Z',
            },
          ],
        },
        always: [
          {
            channel: 'email',
            provider: 'resend',
            providerId: 'email_msg_always_1',
            status: 'sent',
            at: '2026-09-20T12:00:00.000Z',
          },
        ],
        status: 'sent',
        createdAt: '2026-09-20T12:00:00.000Z',
        updatedAt: '2026-09-20T12:00:00.000Z',
      };

      await store.create(initialRecord);
      await store.indexProviderId(providerId, {
        id: messageId,
        channel: 'whatsapp',
        provider: 'meta-wa',
      });

      const deliveredEvent: StatusEvent = {
        providerId,
        status: 'delivered',
        at: eventTimestamp,
      };

      const provider: Provider = {
        name: 'meta-wa',
        channel: 'whatsapp',
        send: () => Promise.resolve({ ok: true }),
        webhook: {
          parse: () => Promise.resolve([deliveredEvent]),
        },
      };

      let onStatusCalledWith: unknown = null;

      const handleWebhook = createWebhookHandler({
        providers: { whatsapp: provider },
        kv,
        onStatus: (event) => {
          onStatusCalledWith = event;
        },
      });

      const request = new Request('http://localhost/webhooks/meta-wa', {
        method: 'POST',
        body: JSON.stringify({ id: providerId, status: 'delivered' }),
        headers: { 'content-type': 'application/json' },
      });

      const response = await handleWebhook('meta-wa', request);
      expect(response.status).toBe(200);

      // Verify status store updated
      const updatedRecord = await store.get(messageId);
      expect(updatedRecord).not.toBeNull();
      expect(updatedRecord?.chain.attempts[0]?.status).toBe('delivered');
      expect(updatedRecord?.chain.attempts[0]?.at).toBe(eventTimestamp);
      expect(updatedRecord?.chain.status).toBe('delivered');
      expect(updatedRecord?.status).toBe('delivered');

      // Verify onStatus called
      expect(onStatusCalledWith).toBeDefined();
      expect(onStatusCalledWith).not.toBeNull();
    });

    it('updates attempt status to failed with error description and timestamp at', async () => {
      const store = kvStatusStore(kv);

      const messageId = 'msg_01J9DISPATCH000000000002';
      const providerId = 'wamid.HBgL_01J9TEST_FAILED';
      const eventTimestamp = '2026-09-20T12:00:10.000Z';
      const failureReason = 'Destination unreachable: user does not exist on WhatsApp';

      const initialRecord: MessageRecord = {
        id: messageId,
        template: 'securityAlert',
        kind: 'notification',
        policy: { fallback: ['whatsapp', 'sms'], always: [] },
        chain: {
          status: 'sent',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId,
              status: 'sent',
              at: '2026-09-20T12:00:00.000Z',
            },
          ],
        },
        always: [],
        status: 'sent',
        createdAt: '2026-09-20T12:00:00.000Z',
        updatedAt: '2026-09-20T12:00:00.000Z',
      };

      await store.create(initialRecord);
      await store.indexProviderId(providerId, {
        id: messageId,
        channel: 'whatsapp',
        provider: 'meta-wa',
      });

      const failedEvent: StatusEvent = {
        providerId,
        status: 'failed',
        error: failureReason,
        at: eventTimestamp,
      };

      const provider: Provider = {
        name: 'meta-wa',
        channel: 'whatsapp',
        send: () => Promise.resolve({ ok: true }),
        webhook: {
          parse: () => Promise.resolve([failedEvent]),
        },
      };

      const handleWebhook = createWebhookHandler({
        providers: { whatsapp: provider },
        kv,
      });

      const request = new Request('http://localhost/webhooks/meta-wa', {
        method: 'POST',
        body: JSON.stringify({ id: providerId, status: 'failed', error: failureReason }),
        headers: { 'content-type': 'application/json' },
      });

      const response = await handleWebhook('meta-wa', request);
      expect(response.status).toBe(200);

      const updatedRecord = await store.get(messageId);
      expect(updatedRecord).not.toBeNull();
      expect(updatedRecord?.chain.attempts[0]?.status).toBe('failed');
      expect(updatedRecord?.chain.attempts[0]?.error).toBe(failureReason);
      expect(updatedRecord?.chain.attempts[0]?.at).toBe(eventTimestamp);
      // The chain is `whatsapp` then `sms` and only WhatsApp has been attempted, so the chain is
      // NOT terminal yet: the webhook path derives the chain status exactly as the send path
      // does, leaving it `pending` until SMS has had its turn. Writing `failed` here would show
      // a client polling /status a final failure that has not happened, and would invite the
      // fallback timer's terminal check to clean up a chain that is still live.
      expect(updatedRecord?.chain.status).toBe('pending');
      expect(updatedRecord?.status).toBe('pending');
    });

    it('marks the chain failed once the failing attempt is the last configured channel', async () => {
      const store = kvStatusStore(kv);

      const messageId = 'msg_01J9DISPATCH000000000012';
      const providerId = 'wamid.HBgL_01J9TEST_LAST_FAILED';
      const eventTimestamp = '2026-09-20T12:00:20.000Z';

      await store.create({
        id: messageId,
        template: 'securityAlert',
        kind: 'notification',
        policy: { fallback: ['whatsapp', 'sms'], always: [] },
        chain: {
          status: 'sent',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId: 'wamid.earlier_whatsapp',
              status: 'failed',
              at: '2026-09-20T12:00:00.000Z',
            },
            {
              channel: 'sms',
              provider: 'http-sms',
              providerId,
              status: 'sent',
              at: '2026-09-20T12:00:05.000Z',
            },
          ],
        },
        always: [],
        status: 'pending',
        createdAt: '2026-09-20T12:00:00.000Z',
        updatedAt: '2026-09-20T12:00:05.000Z',
      });
      await store.indexProviderId(providerId, {
        id: messageId,
        channel: 'sms',
        provider: 'http-sms',
      });

      const provider: Provider = {
        name: 'http-sms',
        channel: 'sms',
        send: () => Promise.resolve({ ok: true }),
        webhook: {
          parse: (): Promise<StatusEvent[]> =>
            Promise.resolve([
              { providerId, status: 'failed', error: 'carrier rejected', at: eventTimestamp },
            ]),
        },
      };

      const handleWebhook = createWebhookHandler({ providers: { sms: provider }, kv });
      const response = await handleWebhook(
        'http-sms',
        new Request('http://localhost/webhooks/http-sms', { method: 'POST', body: '{}' })
      );
      expect(response.status).toBe(200);

      const updatedRecord = await store.get(messageId);
      // Every configured fallback channel has now been attempted and the last one failed, so
      // the chain really is terminal.
      expect(updatedRecord?.chain.status).toBe('failed');
      expect(updatedRecord?.status).toBe('failed');
    });

    it('keeps a non-terminal webhook status verbatim on a chain with channels left to try', async () => {
      const store = kvStatusStore(kv);

      const messageId = 'msg_01J9DISPATCH000000000013';
      const providerId = 'wamid.HBgL_01J9TEST_DELIVERED_EARLY';

      await store.create({
        id: messageId,
        template: 'securityAlert',
        kind: 'notification',
        policy: { fallback: ['whatsapp', 'sms'], always: [] },
        chain: {
          status: 'sent',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId,
              status: 'sent',
              at: '2026-09-20T12:00:00.000Z',
            },
          ],
        },
        always: [],
        status: 'sent',
        createdAt: '2026-09-20T12:00:00.000Z',
        updatedAt: '2026-09-20T12:00:00.000Z',
      });
      await store.indexProviderId(providerId, {
        id: messageId,
        channel: 'whatsapp',
        provider: 'meta-wa',
      });

      const provider: Provider = {
        name: 'meta-wa',
        channel: 'whatsapp',
        send: () => Promise.resolve({ ok: true }),
        webhook: {
          parse: (): Promise<StatusEvent[]> =>
            Promise.resolve([{ providerId, status: 'delivered', at: '2026-09-20T12:00:30.000Z' }]),
        },
      };

      const handleWebhook = createWebhookHandler({ providers: { whatsapp: provider }, kv });
      await handleWebhook(
        'meta-wa',
        new Request('http://localhost/webhooks/meta-wa', { method: 'POST', body: '{}' })
      );

      const updatedRecord = await store.get(messageId);
      // Only a `failed` tail is held back for the channels still to come; a success ends the
      // chain wherever it lands.
      expect(updatedRecord?.chain.status).toBe('delivered');
      expect(updatedRecord?.status).toBe('delivered');
    });
  });

  describe('Unknown Provider ID Handling', () => {
    it('acknowledges with 200 when providerId is unknown, skipping without error', async () => {
      let wasParseCalled = false;
      const unknownId = 'wamid.unknown_vendor_msg_999999';

      const provider: Provider = {
        name: 'meta-wa',
        channel: 'whatsapp',
        send: () => Promise.resolve({ ok: true }),
        webhook: {
          parse: () => {
            wasParseCalled = true;
            return Promise.resolve([
              {
                providerId: unknownId,
                status: 'delivered',
                at: '2026-09-20T12:00:00.000Z',
              },
            ]);
          },
        },
      };

      const handleWebhook = createWebhookHandler({
        providers: { whatsapp: provider },
        kv,
      });

      const request = new Request('http://localhost/webhooks/meta-wa', {
        method: 'POST',
        body: JSON.stringify({ id: unknownId }),
        headers: { 'content-type': 'application/json' },
      });

      const response = await handleWebhook('meta-wa', request);
      expect(response.status).toBe(200);
      expect(wasParseCalled).toBe(true);
    });

    it('returns 200 when every event in a batch payload has an unknown providerId', async () => {
      let wasParseCalled = false;
      const unknownEvents: StatusEvent[] = [
        { providerId: 'unknown_id_1', status: 'delivered', at: '2026-09-20T12:00:01.000Z' },
        { providerId: 'unknown_id_2', status: 'read', at: '2026-09-20T12:00:02.000Z' },
        { providerId: 'unknown_id_3', status: 'failed', at: '2026-09-20T12:00:03.000Z' },
      ];

      const provider: Provider = {
        name: 'meta-wa',
        channel: 'whatsapp',
        send: () => Promise.resolve({ ok: true }),
        webhook: {
          parse: () => {
            wasParseCalled = true;
            return Promise.resolve(unknownEvents);
          },
        },
      };

      const handleWebhook = createWebhookHandler({
        providers: { whatsapp: provider },
        kv,
      });

      const request = new Request('http://localhost/webhooks/meta-wa', {
        method: 'POST',
        body: JSON.stringify({ events: unknownEvents }),
        headers: { 'content-type': 'application/json' },
      });

      // Vendors retry on non-2xx; must always 200 after successful parse even if all IDs unknown
      const response = await handleWebhook('meta-wa', request);
      expect(response.status).toBe(200);
      expect(wasParseCalled).toBe(true);
    });

    it('updates known attempts and skips unknown ones in a mixed batch, returning 200', async () => {
      const store = kvStatusStore(kv);

      const knownMsgId = 'msg_01J9DISPATCH000000000003';
      const knownProviderId = 'wamid.known_123';

      const initialRecord: MessageRecord = {
        id: knownMsgId,
        template: 'broadcast',
        kind: 'notification',
        policy: { fallback: ['whatsapp'], always: [] },
        chain: {
          status: 'sent',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId: knownProviderId,
              status: 'sent',
              at: '2026-09-20T12:00:00.000Z',
            },
          ],
        },
        always: [],
        status: 'sent',
        createdAt: '2026-09-20T12:00:00.000Z',
        updatedAt: '2026-09-20T12:00:00.000Z',
      };

      await store.create(initialRecord);
      await store.indexProviderId(knownProviderId, {
        id: knownMsgId,
        channel: 'whatsapp',
        provider: 'meta-wa',
      });

      const mixedEvents: StatusEvent[] = [
        { providerId: 'wamid.unknown_xyz', status: 'failed', at: '2026-09-20T12:00:02.000Z' },
        { providerId: knownProviderId, status: 'delivered', at: '2026-09-20T12:00:05.000Z' },
      ];

      const provider: Provider = {
        name: 'meta-wa',
        channel: 'whatsapp',
        send: () => Promise.resolve({ ok: true }),
        webhook: {
          parse: () => Promise.resolve(mixedEvents),
        },
      };

      const handleWebhook = createWebhookHandler({
        providers: { whatsapp: provider },
        kv,
      });

      const request = new Request('http://localhost/webhooks/meta-wa', {
        method: 'POST',
        body: JSON.stringify({ events: mixedEvents }),
        headers: { 'content-type': 'application/json' },
      });

      const response = await handleWebhook('meta-wa', request);
      expect(response.status).toBe(200);

      const updatedRecord = await store.get(knownMsgId);
      expect(updatedRecord?.chain.attempts[0]?.status).toBe('delivered');
    });
  });

  describe('StatusApplied Emission and ExecutionContext', () => {
    it('emits StatusApplied with part=chain for chain attempts', async () => {
      const store = kvStatusStore(kv);

      const messageId = 'msg_01J9CHAIN00000000000001';
      const providerId = 'wamid.chain_attempt_123';
      const eventTimestamp = '2026-09-20T12:00:08.000Z';

      const initialRecord: MessageRecord = {
        id: messageId,
        template: 'otp',
        kind: 'otp',
        policy: { fallback: ['whatsapp', 'sms'], always: [] },
        chain: {
          status: 'sent',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId,
              status: 'sent',
              at: '2026-09-20T12:00:00.000Z',
            },
          ],
        },
        always: [],
        status: 'sent',
        createdAt: '2026-09-20T12:00:00.000Z',
        updatedAt: '2026-09-20T12:00:00.000Z',
      };

      await store.create(initialRecord);
      await store.indexProviderId(providerId, {
        id: messageId,
        channel: 'whatsapp',
        provider: 'meta-wa',
      });

      const appliedEvents: StatusApplied[] = [];

      const statusEvent: StatusEvent = {
        providerId,
        status: 'delivered',
        at: eventTimestamp,
      };

      const provider: Provider = {
        name: 'meta-wa',
        channel: 'whatsapp',
        send: () => Promise.resolve({ ok: true }),
        webhook: {
          parse: () => Promise.resolve([statusEvent]),
        },
      };

      const handleWebhook = createWebhookHandler({
        providers: { whatsapp: provider },
        kv,
        onStatusApplied: (applied) => {
          appliedEvents.push(applied);
        },
      });

      const request = new Request('http://localhost/webhooks/meta-wa', {
        method: 'POST',
        body: JSON.stringify({ id: providerId, status: 'delivered' }),
        headers: { 'content-type': 'application/json' },
      });

      const response = await handleWebhook('meta-wa', request);
      expect(response.status).toBe(200);

      expect(appliedEvents).toHaveLength(1);
      const emitted = appliedEvents[0];
      expect(emitted.id).toBe(messageId);
      expect(emitted.channel).toBe('whatsapp');
      expect(emitted.provider).toBe('meta-wa');
      expect(emitted.part).toBe('chain');
      expect(emitted.event).toEqual(statusEvent);
    });

    it('does NOT emit StatusApplied for always attempts', async () => {
      const store = kvStatusStore(kv);

      const messageId = 'msg_01J9ALWAYS00000000000001';
      const providerId = 'resend_always_attempt_456';
      const eventTimestamp = '2026-09-20T12:00:09.000Z';

      const initialRecord: MessageRecord = {
        id: messageId,
        template: 'orderReceipt',
        kind: 'notification',
        policy: { fallback: ['whatsapp'], always: ['email'] },
        chain: {
          status: 'sent',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId: 'wamid_wa_1',
              status: 'sent',
              at: '2026-09-20T12:00:00.000Z',
            },
          ],
        },
        always: [
          {
            channel: 'email',
            provider: 'resend-email',
            providerId,
            status: 'sent',
            at: '2026-09-20T12:00:00.000Z',
          },
        ],
        status: 'sent',
        createdAt: '2026-09-20T12:00:00.000Z',
        updatedAt: '2026-09-20T12:00:00.000Z',
      };

      await store.create(initialRecord);
      await store.indexProviderId(providerId, {
        id: messageId,
        channel: 'email',
        provider: 'resend-email',
      });

      const appliedEvents: StatusApplied[] = [];

      const statusEvent: StatusEvent = {
        providerId,
        status: 'delivered',
        at: eventTimestamp,
      };

      const emailProvider: Provider = {
        name: 'resend-email',
        channel: 'email',
        send: () => Promise.resolve({ ok: true }),
        webhook: {
          parse: () => Promise.resolve([statusEvent]),
        },
      };

      const handleWebhook = createWebhookHandler({
        providers: { email: emailProvider },
        kv,
        onStatusApplied: (applied) => {
          appliedEvents.push(applied);
        },
      });

      const request = new Request('http://localhost/webhooks/resend-email', {
        method: 'POST',
        body: JSON.stringify({ id: providerId, status: 'delivered' }),
        headers: { 'content-type': 'application/json' },
      });

      const response = await handleWebhook('resend-email', request);
      expect(response.status).toBe(200);

      // StatusApplied must be emitted ONLY for chain attempts, NEVER for always attempts
      expect(appliedEvents).toHaveLength(0);

      // But the record itself is updated
      const updatedRecord = await store.get(messageId);
      expect(updatedRecord?.always[0]?.status).toBe('delivered');
    });

    it('runs background processing under ctx.waitUntil when ctx is provided', async () => {
      const store = kvStatusStore(kv);

      const messageId = 'msg_01J9CTX00000000000000001';
      const providerId = 'wamid.ctx_attempt_789';

      const initialRecord: MessageRecord = {
        id: messageId,
        template: 'otp',
        kind: 'otp',
        policy: { fallback: ['whatsapp'], always: [] },
        chain: {
          status: 'sent',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId,
              status: 'sent',
              at: '2026-09-20T12:00:00.000Z',
            },
          ],
        },
        always: [],
        status: 'sent',
        createdAt: '2026-09-20T12:00:00.000Z',
        updatedAt: '2026-09-20T12:00:00.000Z',
      };

      await store.create(initialRecord);
      await store.indexProviderId(providerId, {
        id: messageId,
        channel: 'whatsapp',
        provider: 'meta-wa',
      });

      const provider: Provider = {
        name: 'meta-wa',
        channel: 'whatsapp',
        send: () => Promise.resolve({ ok: true }),
        webhook: {
          parse: () =>
            Promise.resolve([{ providerId, status: 'delivered', at: '2026-09-20T12:00:05.000Z' }]),
        },
      };

      const handleWebhook = createWebhookHandler({
        providers: { whatsapp: provider },
        kv,
      });

      const mockCtx: MockExecutionContext = createMockExecutionContext();

      const request = new Request('http://localhost/webhooks/meta-wa', {
        method: 'POST',
        body: JSON.stringify({ id: providerId, status: 'delivered' }),
        headers: { 'content-type': 'application/json' },
      });

      const response = await handleWebhook('meta-wa', request, mockCtx as unknown as ExecutionContext);
      expect(response.status).toBe(200);

      // Verify ctx.waitUntil was called
      expect(mockCtx.promises.length).toBeGreaterThan(0);

      // Flush background promises
      await mockCtx.flush();

      const updatedRecord = await store.get(messageId);
      expect(updatedRecord?.chain.attempts[0]?.status).toBe('delivered');
    });
  });

  describe('Development Bypass (MESSAGING_DEV_UNSIGNED)', () => {
    it('allows dev bypass on localhost URL when MESSAGING_DEV_UNSIGNED is "true"', async () => {
      const store = kvStatusStore(kv);
      const messageId = 'msg_01J9DEV000000000000000001';
      const providerId = 'wamid_dev_01';

      await store.create({
        id: messageId,
        template: 'otp',
        kind: 'otp',
        policy: { fallback: ['whatsapp'], always: [] },
        chain: {
          status: 'sent',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId,
              status: 'sent',
              at: '2026-09-20T12:00:00.000Z',
            },
          ],
        },
        always: [],
        status: 'sent',
        createdAt: '2026-09-20T12:00:00.000Z',
        updatedAt: '2026-09-20T12:00:00.000Z',
      });
      await store.indexProviderId(providerId, {
        id: messageId,
        channel: 'whatsapp',
        provider: 'meta-wa',
      });

      const provider = createSignedProvider();

      const handleWebhook = createWebhookHandler({
        providers: { whatsapp: provider },
        kv,
        env: { MESSAGING_DEV_UNSIGNED: 'true' },
      });

      // Request without signature header sent to localhost URL
      const unsignedLocalhostRequest = new Request('http://localhost:8787/webhooks/meta-wa', {
        method: 'POST',
        body: JSON.stringify({ id: providerId, status: 'delivered' }),
        headers: { 'content-type': 'application/json' },
      });

      const response = await handleWebhook('meta-wa', unsignedLocalhostRequest);
      expect(response.status).toBe(200);

      const updatedRecord = await store.get(messageId);
      expect(updatedRecord?.chain.attempts[0]?.status).toBe('delivered');
    });

    it('allows dev bypass on 127.0.0.1 URL when MESSAGING_DEV_UNSIGNED is "true"', async () => {
      const store = kvStatusStore(kv);
      const messageId = 'msg_01J9DEV000000000000000002';
      const providerId = 'wamid_dev_02';

      await store.create({
        id: messageId,
        template: 'otp',
        kind: 'otp',
        policy: { fallback: ['whatsapp'], always: [] },
        chain: {
          status: 'sent',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-wa',
              providerId,
              status: 'sent',
              at: '2026-09-20T12:00:00.000Z',
            },
          ],
        },
        always: [],
        status: 'sent',
        createdAt: '2026-09-20T12:00:00.000Z',
        updatedAt: '2026-09-20T12:00:00.000Z',
      });
      await store.indexProviderId(providerId, {
        id: messageId,
        channel: 'whatsapp',
        provider: 'meta-wa',
      });

      const provider = createSignedProvider();

      const handleWebhook = createWebhookHandler({
        providers: { whatsapp: provider },
        kv,
        env: { MESSAGING_DEV_UNSIGNED: 'true' },
      });

      // Request without signature header sent to 127.0.0.1 URL
      const unsignedIpRequest = new Request('http://127.0.0.1:8787/webhooks/meta-wa', {
        method: 'POST',
        body: JSON.stringify({ id: providerId, status: 'delivered' }),
        headers: { 'content-type': 'application/json' },
      });

      const response = await handleWebhook('meta-wa', unsignedIpRequest);
      expect(response.status).toBe(200);

      const updatedRecord = await store.get(messageId);
      expect(updatedRecord?.chain.attempts[0]?.status).toBe('delivered');
    });

    it('REFUSES dev bypass and returns 401 on non-localhost URL even when MESSAGING_DEV_UNSIGNED is "true"', async () => {
      const provider = createSignedProvider();

      const handleWebhook = createWebhookHandler({
        providers: { whatsapp: provider },
        kv,
        env: { MESSAGING_DEV_UNSIGNED: 'true' },
      });

      // Production hostname with MESSAGING_DEV_UNSIGNED enabled: must refuse bypass and enforce signature
      const unsignedProdRequest = new Request(
        'https://api.messagefall.workers.dev/webhooks/meta-wa',
        {
          method: 'POST',
          body: JSON.stringify({ id: 'wamid_prod_01', status: 'delivered' }),
          headers: { 'content-type': 'application/json' },
        }
      );

      const response = await handleWebhook('meta-wa', unsignedProdRequest);
      expect(response.status).toBe(401);
    });

    it('REFUSES dev bypass and returns 401 when MESSAGING_DEV_UNSIGNED is not "true" even on localhost', async () => {
      const provider = createSignedProvider();

      const handleWebhook = createWebhookHandler({
        providers: { whatsapp: provider },
        kv,
        env: { MESSAGING_DEV_UNSIGNED: 'false' },
      });

      const unsignedRequest = new Request('http://localhost:8787/webhooks/meta-wa', {
        method: 'POST',
        body: JSON.stringify({ id: 'wamid_dev_03', status: 'delivered' }),
        headers: { 'content-type': 'application/json' },
      });

      const response = await handleWebhook('meta-wa', unsignedRequest);
      expect(response.status).toBe(401);
    });
  });

  describe('Template recovery redaction for object-valued channels', () => {
    it('redacts content echoed by a vendor error against an email template config after in:<id> expiry', async () => {
      const store = kvStatusStore(kv);
      const messageId = 'msg_01J9REDACT0000000000EMAIL';
      const providerId = 'resend_01J9REDACT_EMAIL';
      const secretCode = '913277';

      await store.create(singleAttemptRecord(messageId, providerId, 'loginOtp', 'email', 'resend'));
      await store.indexProviderId(providerId, {
        id: messageId,
        channel: 'email',
        provider: 'resend',
      });

      const templates = {
        loginOtp: {
          kind: 'otp' as const,
          email: {
            subject: (input: { code: string }): string =>
              `Your login code is ${input.code} (expires in 5 minutes)`,
            text: (input: { code: string }): string => `Code: ${input.code}. Do not share it.`,
          },
        },
      };

      const event: StatusEvent = {
        providerId,
        status: 'failed',
        error: `Content rejected: subject "Your login code is ${secretCode} (expires in 5 minutes)" violates policy`,
        at: '2026-09-20T12:05:00.000Z',
      };

      const handleWebhook = createWebhookHandler({
        providers: { email: providerEmitting('resend', event) },
        kv,
        templates,
      });

      const response = await handleWebhook(
        'resend',
        new Request('http://localhost/webhooks/resend', { method: 'POST', body: '{}' })
      );
      expect(response.status).toBe(200);

      const updated = await store.get(messageId);
      const storedError = updated?.chain.attempts[0]?.error;
      expect(storedError).toBeDefined();
      expect(storedError).not.toContain(secretCode);
      expect(storedError).toContain('[redacted]');
      // Only the rendered content is removed; the vendor's own diagnosis survives.
      expect(storedError).toContain('violates policy');
      expect(JSON.stringify(updated)).not.toContain(secretCode);
    });

    it('redacts content echoed by a vendor error against a WhatsApp template config after in:<id> expiry', async () => {
      const store = kvStatusStore(kv);
      const messageId = 'msg_01J9REDACT00000000000WA';
      const providerId = 'wamid.HBgL_01J9REDACT_WA';
      const secretCode = '480221';

      await store.create(singleAttemptRecord(messageId, providerId, 'loginOtp', 'whatsapp', 'meta-wa'));
      await store.indexProviderId(providerId, {
        id: messageId,
        channel: 'whatsapp',
        provider: 'meta-wa',
      });

      const templates = {
        loginOtp: {
          kind: 'notification' as const,
          whatsapp: {
            text: (input: { code: string }): string =>
              `Your verification code is ${input.code}, please keep it private`,
          },
        },
      };

      const event: StatusEvent = {
        providerId,
        status: 'failed',
        error: `(#131047) Message body "Your verification code is ${secretCode}, please keep it private" was undeliverable`,
        at: '2026-09-20T12:05:00.000Z',
      };

      const handleWebhook = createWebhookHandler({
        providers: { whatsapp: providerEmitting('meta-wa', event) },
        kv,
        templates,
      });

      const response = await handleWebhook(
        'meta-wa',
        new Request('http://localhost/webhooks/meta-wa', { method: 'POST', body: '{}' })
      );
      expect(response.status).toBe(200);

      const updated = await store.get(messageId);
      const storedError = updated?.chain.attempts[0]?.error;
      expect(storedError).toBeDefined();
      expect(storedError).not.toContain(secretCode);
      expect(storedError).toContain('[redacted]');
      expect(storedError).toContain('was undeliverable');
      expect(JSON.stringify(updated)).not.toContain(secretCode);
    });

    it('leaves a vendor error intact when a WhatsApp params template offers no literal text to anchor on', async () => {
      const store = kvStatusStore(kv);
      const messageId = 'msg_01J9REDACT000000000PARAM';
      const providerId = 'wamid.HBgL_01J9REDACT_PARAM';

      await store.create(singleAttemptRecord(messageId, providerId, 'loginOtp', 'whatsapp', 'meta-wa'));
      await store.indexProviderId(providerId, {
        id: messageId,
        channel: 'whatsapp',
        provider: 'meta-wa',
      });

      const templates = {
        loginOtp: {
          kind: 'otp' as const,
          whatsapp: {
            template: 'login_otp',
            language: 'en',
            params: (input: { code: string }): string[] => [input.code],
          },
        },
      };

      const event: StatusEvent = {
        providerId,
        status: 'failed',
        error: 'Rate limit exceeded, try again later',
        at: '2026-09-20T12:05:00.000Z',
      };

      const handleWebhook = createWebhookHandler({
        providers: { whatsapp: providerEmitting('meta-wa', event) },
        kv,
        templates,
      });

      const response = await handleWebhook(
        'meta-wa',
        new Request('http://localhost/webhooks/meta-wa', { method: 'POST', body: '{}' })
      );
      expect(response.status).toBe(200);

      const updated = await store.get(messageId);
      expect(updated?.chain.attempts[0]?.error).toBe('Rate limit exceeded, try again later');
    });
  });

  describe('Per-event resilience on the inline (no-ctx) path', () => {
    it('acknowledges with 200 when the pid index resolves but the msg record has expired', async () => {
      const { logs, restore } = captureConsole();
      try {
        const store = kvStatusStore(kv);
        const liveId = 'msg_01J9RESILIENCE00000LIVE';
        const expiredProviderId = 'wamid.HBgL_01J9EXPIRED';
        const liveProviderId = 'wamid.HBgL_01J9LIVE';

        // The `pid:` index outlives its `msg:` record: it is written later (at attempt time) than
        // the record (at create time), so a status event can resolve to an id with nothing behind it.
        await store.indexProviderId(expiredProviderId, {
          id: 'msg_01J9RESILIENCE000EXPIRED',
          channel: 'whatsapp',
          provider: 'meta-wa',
        });

        await store.create(
          singleAttemptRecord(liveId, liveProviderId, 'loginOtp', 'whatsapp', 'meta-wa')
        );
        await store.indexProviderId(liveProviderId, {
          id: liveId,
          channel: 'whatsapp',
          provider: 'meta-wa',
        });

        const provider: Provider = {
          name: 'meta-wa',
          channel: 'whatsapp',
          send: () => Promise.resolve({ ok: true }),
          webhook: {
            parse: () =>
              Promise.resolve([
                { providerId: expiredProviderId, status: 'delivered', at: '2026-09-20T13:00:00.000Z' },
                { providerId: liveProviderId, status: 'delivered', at: '2026-09-20T13:00:01.000Z' },
              ]),
          },
        };

        const handleWebhook = createWebhookHandler({ providers: { whatsapp: provider }, kv });

        const response = await handleWebhook(
          'meta-wa',
          new Request('http://localhost/webhooks/meta-wa', { method: 'POST', body: '{}' })
        );
        expect(response.status).toBe(200);

        // The failure is logged, and the second event of the same batch is still applied.
        expect(logs.some((line) => line.includes('webhook.event-failed'))).toBe(true);
        const updated = await store.get(liveId);
        expect(updated?.chain.attempts[0]?.status).toBe('delivered');
      } finally {
        restore();
      }
    });

    it('acknowledges with 200 and keeps processing when onStatusApplied throws without a ctx', async () => {
      const { logs, restore } = captureConsole();
      try {
        const store = kvStatusStore(kv);
        const firstId = 'msg_01J9RESILIENCE0000FIRST';
        const secondId = 'msg_01J9RESILIENCE000SECOND';
        const firstProviderId = 'wamid.HBgL_01J9THROWS';
        const secondProviderId = 'wamid.HBgL_01J9AFTER';

        for (const [id, providerId] of [
          [firstId, firstProviderId],
          [secondId, secondProviderId],
        ] as const) {
          await store.create(
            singleAttemptRecord(id, providerId, 'loginOtp', 'whatsapp', 'meta-wa')
          );
          await store.indexProviderId(providerId, {
            id,
            channel: 'whatsapp',
            provider: 'meta-wa',
          });
        }

        const provider: Provider = {
          name: 'meta-wa',
          channel: 'whatsapp',
          send: () => Promise.resolve({ ok: true }),
          webhook: {
            parse: () =>
              Promise.resolve([
                { providerId: firstProviderId, status: 'failed', at: '2026-09-20T13:00:00.000Z' },
                { providerId: secondProviderId, status: 'delivered', at: '2026-09-20T13:00:01.000Z' },
              ]),
          },
        };

        const appliedFor: string[] = [];
        const handleWebhook = createWebhookHandler({
          providers: { whatsapp: provider },
          kv,
          // Stands in for `advanceChainFor` blowing up (a MessagingConfigError, a KV fault).
          onStatusApplied: (applied: StatusApplied) => {
            appliedFor.push(applied.id);
            if (applied.id === firstId) {
              throw new Error('advanceChainFor exploded');
            }
          },
        });

        // No ExecutionContext: the batch is applied inline, in the request's own promise.
        const response = await handleWebhook(
          'meta-wa',
          new Request('http://localhost/webhooks/meta-wa', { method: 'POST', body: '{}' })
        );
        expect(response.status).toBe(200);

        expect(logs.some((line) => line.includes('webhook.event-failed'))).toBe(true);
        expect(appliedFor).toEqual([firstId, secondId]);
        const second = await store.get(secondId);
        expect(second?.chain.attempts[0]?.status).toBe('delivered');
      } finally {
        restore();
      }
    });
  });
});
