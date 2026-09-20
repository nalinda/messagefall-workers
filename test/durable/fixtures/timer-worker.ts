/**
 * Worker fixture for the workerd specs of the FallbackTimer (Issue #8).
 *
 * Mirrors the README's quick start: `createMessagingApp` as the default export and the
 * `FallbackTimer` class exported from the same module. Adds `/__test/*` routes so the specs can
 * arm, cancel, fire and inspect the object from outside, and a subclass with two inspection
 * RPC methods. Providers record what they send into `CALLS_KV`, keyed by message id.
 *
 * Built at test time with `Bun.build`.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import { createMessagingApp } from '../../../src/app/hono.js';
import { armTimer, cancelTimer } from '../../../src/core/timer.js';
import { FallbackTimer as PackageFallbackTimer } from '../../../src/durable/fallback-timer.js';
import type { MessagingEnv } from '../../../src/env.js';
import type {
  OutboundMeta,
  Provider,
  RenderedSms,
  RenderedWhatsApp,
  SendResult,
  StatusEvent,
} from '../../../src/providers/types.js';
import { defineTemplates } from '../../../src/templates.js';

type Env = MessagingEnv & { CALLS_KV: KVNamespace };

const templates = defineTemplates({
  loginCode: {
    kind: 'otp',
    whatsapp: {
      template: 'auth_code',
      language: 'en',
      params: (input: { code: string }) => [input.code],
    },
    sms: (input: { code: string }) => `Your code is ${input.code}`,
  },
  reminder: {
    kind: 'notification',
    whatsapp: { text: (input: { text: string }) => `Reminder: ${input.text}` },
    sms: (input: { text: string }) => `Reminder: ${input.text}`,
  },
});

async function parseStatuses(request: Request): Promise<StatusEvent[]> {
  const body = (await request.json()) as
    Array<{ providerId: string; status: StatusEvent['status']; error?: string }> | { providerId: string; status: StatusEvent['status']; error?: string };
  return (Array.isArray(body) ? body : [body]).map((e) => ({
    ...e,
    at: new Date().toISOString(),
  }));
}

function recordingProvider<R>(
  env: Env,
  name: string,
  channel: Provider['channel'],
  summarize: (message: R & OutboundMeta) => Record<string, unknown>
): Provider<R> {
  return {
    name,
    channel,
    send: async (message: R & OutboundMeta): Promise<SendResult> => {
      const key = `${channel}:${message.messageId}`;
      const previous = JSON.parse((await env.CALLS_KV.get(key)) ?? '[]') as unknown[];
      await env.CALLS_KV.put(
        key,
        JSON.stringify([...previous, { to: message.to, ...summarize(message) }])
      );
      return { ok: true, providerId: `${name}:${message.messageId}:${previous.length + 1}` };
    },
    webhook: { parse: parseStatuses },
  };
}

const app = createMessagingApp<Env>({
  templates,
  providers: (env) => ({
    whatsapp: recordingProvider<RenderedWhatsApp>(env as Env, 'wa', 'whatsapp', () => ({})),
    sms: recordingProvider<RenderedSms>(env as Env, 'sms', 'sms', (m) => ({ text: m.text })),
  }),
  delivery: {
    fallback: ['whatsapp', 'sms'],
    // otp is left at its default (30s) and driven by `/__test/fire`; notification is short so
    // a real alarm fires within the test.
    timeout: { notification: 500 },
  },
});

interface Inspection {
  entries: Record<string, unknown>;
  alarm: number | null;
  tables: Array<{ name: string; rows: number }>;
  now: number;
}

/**
 * The class bound as `FALLBACK_TIMER`: the package's object plus two test-only RPC methods.
 */
export class FallbackTimer extends PackageFallbackTimer {
  /**
   * Simulates the alarm coming due (the clock cannot be mocked inside workerd).
   */
  async testFire(): Promise<void> {
    await this.alarm();
  }

  /**
   * Snapshot of this object's storage: KV entries, the scheduled alarm and every non-internal
   * SQLite table with its row count.
   */
  async testInspect(): Promise<Inspection> {
    const storage = this.ctx.storage;
    const entries = Object.fromEntries(await storage.list());
    const alarm = await storage.getAlarm();
    const rows = storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray();
    const names = rows
      .map((row) => row.name)
      .filter((name) => !name.startsWith('_cf_') && !name.startsWith('sqlite_'));
    const tables = names.map((name) => ({
      name,
      rows: Number(storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}"`).one().n),
    }));
    return { entries, alarm, tables, now: Date.now() };
  }
}

type TestStub = { testFire(): Promise<void>; testInspect(): Promise<Inspection> };

function stubFor(env: Env, id: string): TestStub {
  const ns = env.FALLBACK_TIMER;
  if (!ns) {
    throw new Error('FALLBACK_TIMER binding missing in fixture');
  }
  return ns.get(ns.idFromName(id)) as unknown as TestStub;
}

async function handleTest(url: URL, request: Request, env: Env): Promise<Response> {
  const id = url.searchParams.get('id') ?? '';
  switch (url.pathname) {
    case '/__test/arm': {
      const args = (await request.json()) as {
        id: string;
        afterMs: number;
        input: unknown;
        locale: string;
      };
      await armTimer(env.FALLBACK_TIMER, args);
      return Response.json({ ok: true });
    }
    case '/__test/cancel': {
      await cancelTimer(env.FALLBACK_TIMER, id);
      return Response.json({ ok: true });
    }
    case '/__test/fire': {
      await stubFor(env, id).testFire();
      return Response.json({ ok: true });
    }
    case '/__test/inspect': {
      return Response.json(await stubFor(env, id).testInspect());
    }
    case '/__test/calls': {
      const channel = url.searchParams.get('channel') ?? 'sms';
      return Response.json(JSON.parse((await env.CALLS_KV.get(`${channel}:${id}`)) ?? '[]'));
    }
    default: {
      return new Response('not found', { status: 404 });
    }
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/__test/')) {
      return handleTest(url, request, env);
    }
    return app.fetch(request, env, ctx);
  },
};
