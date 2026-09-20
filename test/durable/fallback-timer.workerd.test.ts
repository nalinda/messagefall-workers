/**
 * Failing tests for the FallbackTimer Durable Object under miniflare (GitHub Issue #8).
 *
 * The fixture Worker (`fixtures/timer-worker.ts`) is bundled with `Bun.build` and run in
 * workerd with a SQLite-backed `FALLBACK_TIMER` binding and two KV namespaces. The clock
 * inside workerd cannot be mocked, so the alarm is made "due" in two ways: `/__test/fire`
 * invokes the object's `alarm()` for the 30s OTP timeout, and the notification timeout is set
 * to 500ms so a real alarm fires within the test.
 *
 * Acceptance criteria covered here:
 * - arm, advance past the timeout with no status, alarm fires, an SMS attempt appears;
 * - a `delivered` status before the timeout cancels; the alarm does not fire;
 * - policy `'all'` never arms;
 * - storage is empty after any terminal state (via cancel and via the alarm itself);
 * - one object per message via `idFromName(messageId)`; `armTimer`/`cancelTimer` round-trip
 *   through the real binding.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

import type { MessageRecord } from '../../src/core/status.js';

const rootDir = path.resolve(import.meta.dir, '../..');
const OTP_TIMEOUT = 30_000;
const NOTIFICATION_TIMEOUT = 500;
const TOLERANCE = 5000;
const TO = '+94771234567';
const CODE = '482913';

const STUB_TIMER_MODULE = `
import { DurableObject } from 'cloudflare:workers';
export class FallbackTimer extends DurableObject {
  async arm() {}
  async cancel() {}
  async alarm() {}
}
export async function armTimer() {}
export async function cancelTimer() {}
`;

/**
 * Resolves the fixture's virtual specifiers to the real modules when they exist, otherwise to
 * inert stubs (RED phase) so the Worker builds and the specs fail on their assertions.
 */
function underTestPlugin(): Bun.BunPlugin {
  const candidates: Record<string, string[]> = {
    'messagefall-under-test/fallback-timer': [
      'src/durable/fallback-timer.ts',
      'src/core/timer.ts',
    ],
    'messagefall-under-test/timer': ['src/core/timer.ts', 'src/durable/fallback-timer.ts'],
  };
  return {
    name: 'messagefall-under-test',
    setup(build) {
      // Under `bun test`, Bun.build does not map relative `.js` specifiers onto `.ts` sources
      // the way the CLI does; do it here.
      build.onResolve({ filter: /^\.\.?\/.*\.js$/ }, (args) => {
        const ts = path.resolve(path.dirname(args.importer), args.path.replace(/\.js$/, '.ts'));
        return fs.existsSync(ts) ? { path: ts } : undefined;
      });
      build.onResolve({ filter: /^messagefall-under-test\// }, (args) => {
        const existing = (candidates[args.path] ?? [])
          .map((relative) => path.join(rootDir, relative))
          .find((file) => fs.existsSync(file));
        return existing
          ? { path: existing }
          : { path: `${args.path}.ts`, namespace: 'messagefall-stub' };
      });
      build.onLoad({ filter: /.*/, namespace: 'messagefall-stub' }, () => ({
        contents: STUB_TIMER_MODULE,
        loader: 'ts',
      }));
    },
  };
}

async function buildWorker(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [path.join(import.meta.dir, 'fixtures/timer-worker.ts')],
    target: 'browser',
    format: 'esm',
    external: ['cloudflare:*'],
    plugins: [underTestPlugin()],
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join('\n'));
  }
  return result.outputs[0].text();
}

interface Inspection {
  entries: Record<string, unknown>;
  alarm: number | null;
  tables: Array<{ name: string; rows: number }>;
  now: number;
}

interface SmsCall {
  to: string;
  text: string;
}

/**
 * A running Worker plus typed accessors for its routes.
 */
class Harness {
  private readonly mf: Miniflare;

  constructor(mf: Miniflare) {
    this.mf = mf;
  }

  async json<T>(response: Response): Promise<T> {
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${text}`);
    }
    return JSON.parse(text) as T;
  }

  post(pathname: string, body?: unknown): Promise<Response> {
    return this.mf.dispatchFetch(`https://worker.test${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as unknown as Promise<Response>;
  }

  get(pathname: string): Promise<Response> {
    return this.mf.dispatchFetch(`https://worker.test${pathname}`) as unknown as Promise<Response>;
  }

  async send(body: Record<string, unknown>): Promise<string> {
    const response = await this.post('/send', body);
    const result = await this.json<{ id: string }>(response);
    return result.id;
  }

  async status(id: string): Promise<MessageRecord> {
    return this.json<MessageRecord>(await this.get(`/status/${id}`));
  }

  async inspect(id: string): Promise<Inspection> {
    return this.json<Inspection>(await this.get(`/__test/inspect?id=${encodeURIComponent(id)}`));
  }

  async fire(id: string): Promise<void> {
    await this.json(await this.post(`/__test/fire?id=${encodeURIComponent(id)}`));
  }

  async arm(args: {
    id: string;
    afterMs: number;
    input: unknown;
    locale: string;
  }): Promise<void> {
    await this.json(await this.post('/__test/arm', args));
  }

  async cancel(id: string): Promise<void> {
    await this.json(await this.post(`/__test/cancel?id=${encodeURIComponent(id)}`));
  }

  async smsCalls(id: string): Promise<SmsCall[]> {
    return this.json<SmsCall[]>(
      await this.get(`/__test/calls?channel=sms&id=${encodeURIComponent(id)}`)
    );
  }

  webhook(
    provider: string,
    providerId: string,
    delivery: 'delivered' | 'read' | 'failed'
  ): Promise<Response> {
    return this.post(`/webhooks/${provider}`, { providerId, status: delivery });
  }

  /**
   * Polls until `isSettled` holds for the record, or gives up after `timeoutMs`.
   */
  async waitForRecord(
    id: string,
    isSettled: (record: MessageRecord) => boolean,
    timeoutMs = 5000
  ): Promise<MessageRecord> {
    const deadline = Date.now() + timeoutMs;
    let record = await this.status(id);
    while (!isSettled(record) && Date.now() < deadline) {
      await sleep(50);
      record = await this.status(id);
    }
    return record;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectEmpty(inspection: Inspection): void {
  expect(inspection.entries).toEqual({});
  expect(inspection.alarm).toBeNull();
  expect(inspection.tables.filter((t) => t.rows > 0)).toEqual([]);
}

function expectArmed(inspection: Inspection, afterMs: number, from: number): void {
  const isPopulated =
    Object.keys(inspection.entries).length > 0 || inspection.tables.some((t) => t.rows > 0);
  expect(isPopulated).toBe(true);
  expect(inspection.alarm).not.toBeNull();
  expect(Math.abs((inspection.alarm ?? 0) - (from + afterMs))).toBeLessThanOrEqual(TOLERANCE);
}

const loginCode = { template: 'loginCode', to: TO, locale: 'en', input: { code: CODE } };

describe('Issue #8: FallbackTimer under miniflare', () => {
  let mf: Miniflare;
  let w: Harness;

  beforeAll(async () => {
    const script = await buildWorker();
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script,
        compatibilityDate: '2025-09-01',
        compatibilityFlags: ['nodejs_compat'],
        kvNamespaces: ['MESSAGES_KV', 'CALLS_KV'],
        durableObjects: { FALLBACK_TIMER: { className: 'FallbackTimer', useSQLite: true } },
        bindings: { MESSAGING_DEV_UNSIGNED: 'true' },
      })
    );
    await mf.ready;
    w = new Harness(mf);
  });

  afterAll(async () => {
    await mf.dispose();
  });

  it('a send arms one object per message at now + the otp timeout; the alarm coming due produces an SMS attempt and re-arms', async () => {
    const armedAt = Date.now();
    const id = await w.send(loginCode);
    const sent = await w.waitForRecord(id, (r) => r.chain.attempts.length === 1);
    expect(sent.chain.status).toBe('sent');

    expectArmed(await w.inspect(id), OTP_TIMEOUT, armedAt);

    // No status ever arrives; the alarm comes due.
    const firedAt = Date.now();
    await w.fire(id);

    const advanced = await w.waitForRecord(id, (r) => r.chain.attempts.length === 2);
    expect(advanced.chain.attempts.map((a) => a.channel)).toEqual(['whatsapp', 'sms']);
    expect(advanced.chain.attempts[1].status).toBe('sent');
    expect(advanced.chain.status).toBe('sent');
    const calls = await w.smsCalls(id);
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe(TO);
    expect(calls[0].text).toBe(`Your code is ${CODE}`);

    // The SMS attempt is not terminal: re-armed in the same object.
    expectArmed(await w.inspect(id), OTP_TIMEOUT, firedAt);

    // A delivered status for the SMS attempt is terminal: storage empty.
    const smsProviderId = advanced.chain.attempts[1].providerId ?? '';
    const response = await w.webhook('sms', smsProviderId, 'delivered');
    expect(response.status).toBe(200);
    await w.waitForRecord(id, (r) => r.chain.status === 'delivered');
    expectEmpty(await w.inspect(id));
  });

  it('with no status ever arriving a real alarm fires after the notification timeout; exhaustion by the alarm leaves storage empty', async () => {
    const id = await w.send({
      template: 'reminder',
      to: TO,
      locale: 'en',
      input: { text: 'stand-up' },
    });
    const armedAt = Date.now();
    await w.waitForRecord(id, (r) => r.chain.attempts.length === 1);
    expectArmed(await w.inspect(id), NOTIFICATION_TIMEOUT, armedAt);

    const advanced = await w.waitForRecord(id, (r) => r.chain.attempts.length === 2);
    expect(advanced.chain.attempts[1].channel).toBe('sms');
    const calls = await w.smsCalls(id);
    expect(calls[0]?.text).toBe('Reminder: stand-up');

    const exhausted = await w.waitForRecord(id, (r) => r.chain.status === 'failed');
    expect(exhausted.chain.attempts).toHaveLength(2);
    expect(exhausted.status).toBe('failed');
    expectEmpty(await w.inspect(id));

    // Long after every timeout nothing else happened.
    await sleep(NOTIFICATION_TIMEOUT * 3);
    const later = await w.status(id);
    expect(later.chain.attempts).toHaveLength(2);
    expect(await w.smsCalls(id)).toHaveLength(1);
  });

  it.each(['delivered', 'read'] as const)(
    'a %s status before the timeout cancels: storage empty, no alarm, and a later alarm makes no attempt',
    async (delivery) => {
      const id = await w.send(loginCode);
      const sent = await w.waitForRecord(id, (r) => r.chain.attempts.length === 1);
      const armed = await w.inspect(id);
      expect(armed.alarm).not.toBeNull();

      const waProviderId = sent.chain.attempts[0].providerId ?? '';
      const response = await w.webhook('wa', waProviderId, delivery);
      expect(response.status).toBe(200);
      const settled = await w.waitForRecord(id, (r) => r.chain.status === delivery);
      expect(settled.chain.status).toBe(delivery);
      expectEmpty(await w.inspect(id));

      // Even if the alarm handler ran now, it would find a terminal chain and do nothing.
      await w.fire(id);
      await sleep(200);
      const after = await w.status(id);
      expect(after.chain.attempts).toHaveLength(1);
      expect(after.chain.status).toBe(delivery);
      expect(await w.smsCalls(id)).toHaveLength(0);
      expectEmpty(await w.inspect(id));
    }
  );

  it("policy 'all' never arms", async () => {
    // Positive control: a chained send arms.
    const chained = await w.send(loginCode);
    await w.waitForRecord(chained, (r) => r.chain.attempts.length === 1);
    const control = await w.inspect(chained);
    expect(control.alarm).not.toBeNull();

    const id = await w.send({ ...loginCode, delivery: 'all' });
    const record = await w.waitForRecord(id, (r) => r.always.length === 2);
    expect(record.policy.fallback).toEqual([]);
    expect(record.chain.attempts).toHaveLength(0);
    expectEmpty(await w.inspect(id));

    await sleep(NOTIFICATION_TIMEOUT * 2);
    expectEmpty(await w.inspect(id));
    const later = await w.status(id);
    expect(later.chain.attempts).toHaveLength(0);
  });

  it('armTimer and cancelTimer round-trip through the binding, one object per message id', async () => {
    const a = 'msg_workerd_A';
    const b = 'msg_workerd_B';
    const armedAt = Date.now();
    for (const id of [a, b]) {
      await w.arm({ id, afterMs: OTP_TIMEOUT, input: { code: CODE }, locale: 'en' });
    }
    expectArmed(await w.inspect(a), OTP_TIMEOUT, armedAt);
    expectArmed(await w.inspect(b), OTP_TIMEOUT, armedAt);

    // Re-arming the same id replaces the alarm in the same object rather than adding one.
    await w.arm({ id: a, afterMs: OTP_TIMEOUT * 2, input: { code: CODE }, locale: 'en' });
    expectArmed(await w.inspect(a), OTP_TIMEOUT * 2, armedAt);
    expectArmed(await w.inspect(b), OTP_TIMEOUT, armedAt);

    // Cancelling one leaves the other untouched.
    await w.cancel(a);
    expectEmpty(await w.inspect(a));
    expectArmed(await w.inspect(b), OTP_TIMEOUT, armedAt);

    await w.cancel(b);
    expectEmpty(await w.inspect(b));
  });
});
