/**
 * Failing tests for the FallbackTimer Durable Object (GitHub Issue #8).
 *
 * In-process specification against a local status store and a mocked clock: no Worker,
 * no wrangler. A fake Durable Object runtime instantiates the class per `idFromName`, the
 * clock fires due alarms when advanced, and the record in the status store is the evidence.
 *
 * Acceptance criteria covered here:
 * - arm, advance time past the timeout with no status, alarm fires, an SMS attempt appears;
 * - a `delivered` status before the timeout cancels; the alarm does not fire;
 * - policy `'all'` never arms;
 * - storage is empty after any terminal state (via cancel and via the alarm itself);
 * - the full arm → timeout → alarm → cleanup lifecycle round-trips through `armTimer`, the
 *   alarm firing `advanceChain`, and `cancelTimer` on a terminal status;
 * - without the binding `armTimer`/`cancelTimer` are no-ops and one startup log line says
 *   timed fallback is off.
 *
 * The object obtains its options (templates, providers, store) from the `createMessagingApp` /
 * `createMessaging` call made in the same isolate, as the issue documents: the class must be
 * exported from the Worker that calls `createMessagingApp`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createMessagingApp } from '../../src/app/hono.js';
import { createMessaging, type Messaging, type MessagingOptions } from '../../src/core/messaging.js';
import { kvStatusStore, type MessageRecord, type StatusStore } from '../../src/core/status.js';
import type { MessagingEnv } from '../../src/env.js';
import type { DeliveryStatus } from '../../src/providers/types.js';
import { captureConsole, memoryKV } from '../helpers/messaging.js';
import {
  createFakeDurableRuntime,
  type FakeClock,
  type FakeNamespace,
  loadTimerApi,
  type TimerApi,
  timerEnv,
  type TimerProviders,
  timerProviders,
  timerTemplates,
} from '../helpers/timer.js';

const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const OTP_TIMEOUT = 30_000;
const NOTIFICATION_TIMEOUT = 300_000;
const TO = '+94771234567';
const CODE = '482913';

type TimerMessagingOptions = MessagingOptions<typeof timerTemplates>;

function optionsFor(
  providers: TimerProviders,
  delivery?: TimerMessagingOptions['delivery']
): TimerMessagingOptions {
  return {
    templates: timerTemplates,
    providers: () => ({ whatsapp: providers.whatsapp, sms: providers.sms }),
    delivery: delivery ?? { fallback: ['whatsapp', 'sms'] },
  };
}

/**
 * Seeds a record whose whatsapp attempt is `sent`, plus the `in:<id>` entry `send` writes for
 * the async fallback path (#7): recipient, locale and raw input, which is where
 * `advanceChain` takes the recipient from.
 */
async function seedSent(
  store: StatusStore,
  kv: MessagingEnv['MESSAGES_KV'],
  record: MessageRecord
): Promise<void> {
  await store.create(record);
  await kv.put(`in:${record.id}`, JSON.stringify({ input: { code: CODE }, to: TO, locale: 'en' }));
}

function sentRecord(id: string): MessageRecord {
  return {
    id,
    template: 'loginCode',
    kind: 'otp',
    policy: { fallback: ['whatsapp', 'sms'], always: [] },
    chain: {
      status: 'sent',
      attempts: [
        {
          channel: 'whatsapp',
          provider: 'wa',
          providerId: 'wa_1',
          status: 'sent',
          at: new Date(T0).toISOString(),
        },
      ],
    },
    always: [],
    status: 'sent',
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
  };
}

/**
 * The record for `id`; fails the test when it is missing.
 */
async function recordOf(store: StatusStore, id: string): Promise<MessageRecord> {
  const record = await store.get(id);
  if (!record) {
    throw new Error(`no record for ${id}`);
  }
  return record;
}

/**
 * The providerId of chain attempt `index`.
 */
async function chainProviderId(store: StatusStore, id: string, index: number): Promise<string> {
  const record = await recordOf(store, id);
  const providerId = record.chain.attempts.at(index)?.providerId;
  if (!providerId) {
    throw new Error(`chain attempt ${index} of ${id} has no providerId`);
  }
  return providerId;
}

async function chainOf(store: StatusStore, id: string): Promise<MessageRecord['chain']> {
  const record = await recordOf(store, id);
  return record.chain;
}

function isTimerLine(line: string): boolean {
  return /timer|timed fallback/i.test(line);
}

function statusRequest(providerId: string, status: DeliveryStatus): Request {
  return new Request('https://worker.test/webhooks/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId, status }),
  });
}

describe('Issue #8: FallbackTimer Durable Object for timed fallback', () => {
  let api: TimerApi;
  let providers: TimerProviders;
  let env: MessagingEnv;
  let kv: MessagingEnv['MESSAGES_KV'];
  let store: StatusStore;
  let ns: FakeNamespace;
  let clock: FakeClock;
  let messaging: Messaging<typeof timerTemplates>;

  /**
   * Wires a messaging instance (and the app that registers the options for the object) for the
   * current env and providers.
   */
  function wire(delivery?: TimerMessagingOptions['delivery']): void {
    const options = optionsFor(providers, delivery);
    createMessagingApp(options);
    messaging = createMessaging(env, options);
  }

  beforeEach(async () => {
    api = await loadTimerApi();
    providers = timerProviders();
    kv = memoryKV();
    const runtime = createFakeDurableRuntime(api.FallbackTimer, () => env, T0);
    ns = runtime.ns;
    clock = runtime.clock;
    env = timerEnv(kv, ns.namespace);
    store = kvStatusStore(kv);
    wire();
  });

  afterEach(() => {
    clock.restore();
  });

  describe('arm → timeout → alarm → cleanup lifecycle (local status store, mocked clock)', () => {
    it('armTimer schedules the alarm, the alarm fires advanceChain({ reason: "timeout" }) producing an SMS attempt, and cancelTimer on delivered empties storage', async () => {
      const id = 'msg_01J9FB0000000000000000TM01';
      await seedSent(store, kv, sentRecord(id));
      await store.indexProviderId('wa_1', { id, channel: 'whatsapp', provider: 'wa' });

      await api.armTimer(env.FALLBACK_TIMER, {
        id,
        afterMs: OTP_TIMEOUT,
        input: { code: CODE },
        locale: 'en',
      });

      // One object per message, addressed by idFromName(messageId), holding the record.
      expect(ns.idFromNameCalls).toContain(id);
      expect(ns.storageOf(id).size).toBeGreaterThan(0);
      expect(await ns.alarmOf(id)).toBe(T0 + OTP_TIMEOUT);

      // Just before the timeout nothing happens.
      await clock.advance(OTP_TIMEOUT - 1);
      expect(providers.sms.calls).toHaveLength(0);
      const untouched = await chainOf(store, id);
      expect(untouched.attempts).toHaveLength(1);

      // At the timeout the alarm fires and the chain advances to SMS from the stored input.
      await clock.advance(1);
      expect(ns.calls.filter((c) => c.name === id && c.method === 'alarm')).toHaveLength(1);
      expect(providers.sms.calls).toHaveLength(1);
      expect(providers.sms.calls[0].to).toBe(TO);
      expect(providers.sms.calls[0].text).toBe(`Your code is ${CODE}`);
      expect(providers.sms.calls[0].messageId).toBe(id);

      const advanced = await store.get(id);
      expect(advanced?.chain.attempts.map((a) => a.channel)).toEqual(['whatsapp', 'sms']);
      expect(advanced?.chain.attempts[1].status).toBe('sent');
      expect(advanced?.chain.status).toBe('sent');

      // The SMS attempt is not terminal: the chain re-arms for the next timeout.
      expect(await ns.alarmOf(id)).toBe(T0 + OTP_TIMEOUT * 2);
      expect(ns.storageOf(id).size).toBeGreaterThan(0);

      // A terminal status arrives: cancelTimer clears storage and the alarm ...
      await store.update(id, (r) => ({
        ...r,
        chain: {
          ...r.chain,
          status: 'delivered',
          attempts: r.chain.attempts.map((a, i) => (i === 1 ? { ...a, status: 'delivered' } : a)),
        },
        status: 'delivered',
      }));
      await api.cancelTimer(env.FALLBACK_TIMER, id);
      expect(ns.storageOf(id).size).toBe(0);
      expect(await ns.alarmOf(id)).toBeNull();

      // ... and nothing fires afterwards.
      await clock.advance(OTP_TIMEOUT * 10);
      expect(ns.calls.filter((c) => c.name === id && c.method === 'alarm')).toHaveLength(1);
      expect(providers.sms.calls).toHaveLength(1);
      const final = await chainOf(store, id);
      expect(final.attempts).toHaveLength(2);
    });

    it('an alarm whose advance exhausts the chain leaves storage empty (terminal reached by the alarm itself)', async () => {
      const id = 'msg_01J9FB0000000000000000TM02';
      await seedSent(store, kv, sentRecord(id));
      providers.sms.failNext('gateway down');

      await api.armTimer(env.FALLBACK_TIMER, {
        id,
        afterMs: OTP_TIMEOUT,
        input: { code: CODE },
        locale: 'en',
      });
      await clock.advance(OTP_TIMEOUT);

      expect(providers.sms.calls).toHaveLength(1);
      const record = await store.get(id);
      expect(record?.chain.status).toBe('failed');
      expect(record?.chain.attempts.map((a) => a.status)).toEqual(['sent', 'failed']);

      expect(ns.storageOf(id).size).toBe(0);
      expect(await ns.alarmOf(id)).toBeNull();
    });

    it('an alarm that finds the chain already terminal makes no attempt and cleans up', async () => {
      const id = 'msg_01J9FB0000000000000000TM03';
      await seedSent(store, kv, {
        ...sentRecord(id),
        chain: {
          status: 'delivered',
          attempts: [{ ...sentRecord(id).chain.attempts[0], status: 'delivered' }],
        },
        status: 'delivered',
      });

      await api.armTimer(env.FALLBACK_TIMER, {
        id,
        afterMs: OTP_TIMEOUT,
        input: { code: CODE },
        locale: 'en',
      });
      expect(ns.storageOf(id).size).toBeGreaterThan(0);

      await clock.advance(OTP_TIMEOUT);

      expect(providers.sms.calls).toHaveLength(0);
      const chain = await chainOf(store, id);
      expect(chain.attempts).toHaveLength(1);
      expect(ns.storageOf(id).size).toBe(0);
      expect(await ns.alarmOf(id)).toBeNull();
    });

    it('arming the same message again reuses the one object (idFromName) and replaces its alarm', async () => {
      const id = 'msg_01J9FB0000000000000000TM04';
      await seedSent(store, kv, sentRecord(id));
      const args = { id, afterMs: OTP_TIMEOUT, input: { code: CODE }, locale: 'en' };

      await api.armTimer(env.FALLBACK_TIMER, args);
      await clock.advance(10_000);
      await api.armTimer(env.FALLBACK_TIMER, args);

      expect(ns.objects.size).toBe(1);
      expect(ns.idFromNameCalls.every((name) => name === id)).toBe(true);
      expect(ns.idFromNameCalls.length).toBeGreaterThanOrEqual(2);
      expect(await ns.alarmOf(id)).toBe(T0 + 10_000 + OTP_TIMEOUT);

      // The first alarm time passes without firing; the replaced one fires.
      await clock.advance(OTP_TIMEOUT - 10_000);
      expect(providers.sms.calls).toHaveLength(0);
      await clock.advance(10_000);
      expect(providers.sms.calls).toHaveLength(1);
    });
  });

  describe('send arms the timer', () => {
    it('a send with more than one chain channel arms one object per message at now + the otp default (30s)', async () => {
      const first = await messaging.send({
        template: 'loginCode',
        to: TO,
        locale: 'en',
        input: { code: CODE },
      });
      const second = await messaging.send({
        template: 'loginCode',
        to: '+94770000002',
        locale: 'en',
        input: { code: '111111' },
      });

      expect(first.id).not.toBe(second.id);
      expect(ns.idFromNameCalls).toContain(first.id);
      expect(ns.idFromNameCalls).toContain(second.id);
      expect(ns.objects.size).toBe(2);
      expect(ns.storageOf(first.id).size).toBeGreaterThan(0);
      expect(ns.storageOf(second.id).size).toBeGreaterThan(0);
      expect(await ns.alarmOf(first.id)).toBe(T0 + OTP_TIMEOUT);
      expect(await ns.alarmOf(second.id)).toBe(T0 + OTP_TIMEOUT);
    });

    it('the timeout comes from the kind: notification defaults to 300s and delivery.timeout overrides per kind', async () => {
      const notification = await messaging.send({
        template: 'reminder',
        to: TO,
        locale: 'en',
        input: { text: 'stand-up' },
      });
      expect(await ns.alarmOf(notification.id)).toBe(T0 + NOTIFICATION_TIMEOUT);

      wire({ fallback: ['whatsapp', 'sms'], timeout: { otp: 5000, notification: 7000 } });
      const otp = await messaging.send({
        template: 'loginCode',
        to: TO,
        locale: 'en',
        input: { code: CODE },
      });
      expect(await ns.alarmOf(otp.id)).toBe(T0 + 5000);
      const overridden = await messaging.send({
        template: 'reminder',
        to: TO,
        locale: 'en',
        input: { text: 'retro' },
      });
      expect(await ns.alarmOf(overridden.id)).toBe(T0 + 7000);
    });

    it("policy 'all' never arms, and neither does a single-channel chain", async () => {
      // Positive control: the default chain arms.
      const chained = await messaging.send({
        template: 'loginCode',
        to: TO,
        locale: 'en',
        input: { code: CODE },
      });
      expect(ns.storageOf(chained.id).size).toBeGreaterThan(0);
      const armedBefore = ns.calls.filter((c) => c.method === 'arm').length;
      expect(armedBefore).toBeGreaterThan(0);

      const all = await messaging.send({
        template: 'loginCode',
        to: TO,
        locale: 'en',
        input: { code: CODE },
        delivery: 'all',
      });
      const single = await messaging.send({
        template: 'loginCode',
        to: TO,
        locale: 'en',
        input: { code: CODE },
        delivery: { fallback: ['whatsapp'] },
      });

      const allRecord = await recordOf(store, all.id);
      const singleRecord = await recordOf(store, single.id);
      expect(allRecord.policy.fallback).toEqual([]);
      expect(singleRecord.policy.fallback).toEqual(['whatsapp']);
      expect(ns.idFromNameCalls).not.toContain(all.id);
      expect(ns.idFromNameCalls).not.toContain(single.id);
      expect(ns.calls.filter((c) => c.method === 'arm')).toHaveLength(armedBefore);
      expect(ns.objects.has(all.id)).toBe(false);
      expect(ns.objects.has(single.id)).toBe(false);

      // Nothing ever fires for them, even long after every timeout.
      await clock.advance(NOTIFICATION_TIMEOUT * 2);
      expect(ns.calls.filter((c) => c.method === 'alarm' && c.name !== chained.id)).toHaveLength(
        0
      );
      const allChain = await chainOf(store, all.id);
      const singleChain = await chainOf(store, single.id);
      expect(allChain.attempts).toHaveLength(0);
      expect(singleChain.attempts).toHaveLength(1);
    });

    it('with no status ever arriving the chain advances purely from the timeout, re-arms, then exhausts and empties storage; logs carry no content', async () => {
      const captured = captureConsole();
      try {
        const { id } = await messaging.send({
          template: 'loginCode',
          to: TO,
          locale: 'en',
          input: { code: CODE },
        });
        expect(providers.whatsapp.calls).toHaveLength(1);
        expect(providers.sms.calls).toHaveLength(0);

        await clock.advance(OTP_TIMEOUT);

        expect(providers.sms.calls).toHaveLength(1);
        expect(providers.sms.calls[0].to).toBe(TO);
        expect(providers.sms.calls[0].text).toBe(`Your code is ${CODE}`);
        const afterTimeout = await store.get(id);
        expect(afterTimeout?.chain.attempts.map((a) => a.channel)).toEqual(['whatsapp', 'sms']);
        expect(afterTimeout?.chain.status).toBe('sent');
        expect(afterTimeout?.status).toBe('sent');

        // Re-armed after the non-terminal SMS attempt.
        expect(await ns.alarmOf(id)).toBe(T0 + OTP_TIMEOUT * 2);

        // The second timeout exhausts the chain: terminal, storage empty.
        await clock.advance(OTP_TIMEOUT);
        const exhausted = await store.get(id);
        expect(exhausted?.chain.status).toBe('failed');
        expect(exhausted?.chain.attempts).toHaveLength(2);
        expect(ns.storageOf(id).size).toBe(0);
        expect(await ns.alarmOf(id)).toBeNull();

        // Nothing more happens.
        await clock.advance(OTP_TIMEOUT * 10);
        expect(providers.sms.calls).toHaveLength(1);
      } finally {
        captured.restore();
      }
      for (const line of captured.logs) {
        expect(line).not.toContain(CODE);
        expect(line).not.toContain('Your code is');
      }
    });
  });

  describe('statuses and the timer', () => {
    it.each(['delivered', 'read'] as const)(
      'a %s status before the timeout cancels the timer, empties storage and the alarm never fires',
      async (status) => {
        const { id } = await messaging.send({
          template: 'loginCode',
          to: TO,
          locale: 'en',
          input: { code: CODE },
        });
        const providerId = await chainProviderId(store, id, 0);
        expect(await ns.alarmOf(id)).toBe(T0 + OTP_TIMEOUT);

        await clock.advance(1000);
        const response = await messaging.handleWebhook('wa', statusRequest(providerId, status));
        expect(response.status).toBe(200);

        const settled = await chainOf(store, id);
        expect(settled.status).toBe(status);
        expect(ns.storageOf(id).size).toBe(0);
        expect(await ns.alarmOf(id)).toBeNull();

        await clock.advance(OTP_TIMEOUT * 10);
        expect(ns.calls.filter((c) => c.name === id && c.method === 'alarm')).toHaveLength(0);
        expect(providers.sms.calls).toHaveLength(0);
        const record = await store.get(id);
        expect(record?.chain.attempts).toHaveLength(1);
        expect(record?.chain.status).toBe(status);
      }
    );

    it('a failed status advances immediately and re-arms; the failure that exhausts the chain empties storage', async () => {
      const { id } = await messaging.send({
        template: 'loginCode',
        to: TO,
        locale: 'en',
        input: { code: CODE },
      });
      const waProviderId = await chainProviderId(store, id, 0);

      await clock.advance(1000);
      await messaging.handleWebhook('wa', statusRequest(waProviderId, 'failed'));

      expect(providers.sms.calls).toHaveLength(1);
      expect(providers.sms.calls[0].to).toBe(TO);
      const afterFailure = await store.get(id);
      expect(afterFailure?.chain.attempts.map((a) => a.channel)).toEqual(['whatsapp', 'sms']);
      expect(afterFailure?.chain.status).toBe('sent');
      // Re-armed from the time of the SMS attempt, not the original send.
      expect(await ns.alarmOf(id)).toBe(T0 + 1000 + OTP_TIMEOUT);
      expect(ns.storageOf(id).size).toBeGreaterThan(0);

      const smsProviderId = await chainProviderId(store, id, 1);
      await messaging.handleWebhook('sms', statusRequest(smsProviderId, 'failed'));

      const exhausted = await store.get(id);
      expect(exhausted?.chain.status).toBe('failed');
      expect(ns.storageOf(id).size).toBe(0);
      expect(await ns.alarmOf(id)).toBeNull();

      await clock.advance(OTP_TIMEOUT * 10);
      expect(ns.calls.filter((c) => c.name === id && c.method === 'alarm')).toHaveLength(0);
      expect(providers.sms.calls).toHaveLength(1);
    });
  });

  describe('binding absent', () => {
    it('armTimer and cancelTimer are no-ops, each createMessagingApp instance logs exactly one non-error "timed fallback off" line on its first request, and explicit failures still advance', async () => {
      const bareKv = memoryKV();
      const bare = timerEnv(bareKv);
      const bareStore = kvStatusStore(bareKv);
      const options = optionsFor(providers);
      const sendBody = (to: string): string =>
        JSON.stringify({ template: 'loginCode', to, locale: 'en', input: { code: CODE } });
      const sendInit = (to: string): RequestInit => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: sendBody(to),
      });

      // Positive control: the same options with the binding do arm.
      const appWithTimer = createMessagingApp(options);
      const armedResponse = await appWithTimer.request('/send', sendInit(TO), env);
      expect(armedResponse.status).toBe(200);
      expect(ns.calls.filter((c) => c.method === 'arm')).toHaveLength(1);

      // The scope of "startup" is one createMessagingApp instance: this test does not depend
      // on any module-level once-flag another test file may already have consumed.
      const app = createMessagingApp(options);
      const captured = captureConsole(['log', 'info', 'warn']);
      const errors = captureConsole(['error']);
      let ids: string[] = [];
      try {
        const armed = api.armTimer(undefined, {
          id: 'msg_none',
          afterMs: OTP_TIMEOUT,
          input: { code: CODE },
          locale: 'en',
        });
        expect(await armed).toBeUndefined();
        const cancelled = api.cancelTimer(undefined, 'msg_none');
        expect(await cancelled).toBeUndefined();

        for (const to of [TO, '+94770000002']) {
          const response = await app.request('/send', sendInit(to), bare);
          expect(response.status).toBe(200);
          const body = (await response.json()) as { id: string };
          ids = [...ids, body.id];
        }
      } finally {
        captured.restore();
        errors.restore();
      }

      // Exactly one line for this instance across two requests, not an error, without content.
      const timerLines = captured.logs.filter((line) => isTimerLine(line));
      expect(timerLines).toHaveLength(1);
      expect(timerLines[0]).not.toContain(CODE);
      expect(errors.logs.filter((line) => isTimerLine(line))).toHaveLength(0);

      // A second instance without the binding logs its own single line.
      const secondApp = createMessagingApp(options);
      const secondCapture = captureConsole(['log', 'info', 'warn']);
      try {
        for (const to of [TO, '+94770000003']) {
          const response = await secondApp.request('/send', sendInit(to), bare);
          expect(response.status).toBe(200);
        }
      } finally {
        secondCapture.restore();
      }
      expect(secondCapture.logs.filter((line) => isTimerLine(line))).toHaveLength(1);

      // No timer was touched for the bare env; the sends still went out.
      expect(ns.calls.filter((c) => c.method === 'arm')).toHaveLength(1);
      for (const id of ids) {
        expect(ns.objects.has(id)).toBe(false);
        const chain = await chainOf(bareStore, id);
        expect(chain.status).toBe('sent');
      }

      // Explicit failures still drive the chain without a timer.
      const bareMessaging = createMessaging(bare, options);
      const providerId = await chainProviderId(bareStore, ids[0], 0);
      const smsBefore = providers.sms.calls.length;
      await bareMessaging.handleWebhook('wa', statusRequest(providerId, 'failed'));
      expect(providers.sms.calls).toHaveLength(smsBefore + 1);
      const advanced = await chainOf(bareStore, ids[0]);
      expect(advanced.attempts.map((a) => a.channel)).toEqual(['whatsapp', 'sms']);
    });
  });
});
