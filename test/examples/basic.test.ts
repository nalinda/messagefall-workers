/**
 * Tests for the Basic Worker Example under examples/basic (Issue #14).
 *
 * Acceptance criteria & requirements verified:
 * - Worker starts under Miniflare and serves send, status, and webhook routes.
 * - POST /send for a notification template (fallback chain + always-on channel) returns 200 with an id.
 * - GET /status/:id returns the record.
 * - POST /webhooks/:provider for console provider advances fallback chain on failure and completes on delivery.
 * - POST /send for an OTP-style template works.
 * - Assert wrangler config declares FallbackTimer Durable Object binding and SQLite migration.
 * - Assert no provider is configured with real credentials (console provider only).
 * - Assert createMessagingApp runs at module scope and FallbackTimer is exported.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

import type { MessageRecord } from '../../src/core/status.js';
import { TEST_ENC_KEY } from '../helpers/messaging.js';

const rootDir = path.resolve(import.meta.dir, '../..');
const exampleDir = path.join(rootDir, 'examples/basic');

function tsSourcesPlugin(): Bun.BunPlugin {
  return {
    name: 'ts-sources',
    setup(build) {
      build.onResolve({ filter: /^messagefall-workers$/ }, () => ({
        path: path.join(rootDir, 'src/index.ts'),
      }));
      build.onResolve({ filter: /^messagefall-workers\/durable$/ }, () => ({
        path: path.join(rootDir, 'src/durable/index.ts'),
      }));
      build.onResolve({ filter: /^messagefall-workers\/providers\/(.*)$/ }, (args) => ({
        path: path.join(
          rootDir,
          'src/providers',
          args.path.replace('messagefall-workers/providers/', ''),
          'index.ts'
        ),
      }));
      build.onResolve({ filter: /^\.\.?\/.*\.js$/ }, (args) => {
        const ts = path.resolve(path.dirname(args.importer), args.path.replace(/\.js$/, '.ts'));
        return fs.existsSync(ts) ? { path: ts } : undefined;
      });
    },
  };
}

async function buildExampleWorker(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [path.join(exampleDir, 'src/index.ts')],
    target: 'browser',
    format: 'esm',
    external: ['cloudflare:*'],
    plugins: [tsSourcesPlugin()],
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join('\n'));
  }
  return result.outputs[0].text();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Issue #14: Example Worker under examples/basic', () => {
  describe('Wrangler configuration & Worker structure', () => {
    it('declares FallbackTimer Durable Object binding and SQLite migration in wrangler.jsonc', () => {
      const wranglerPath = path.join(exampleDir, 'wrangler.jsonc');
      expect(fs.existsSync(wranglerPath)).toBe(true);

      const rawContent = fs.readFileSync(wranglerPath, 'utf8');
      // Strip comments and trailing commas for JSON parsing
      const jsonContent = rawContent
        .replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')
        .replaceAll(/,(\s*[\]}])/g, '$1');
      const config = JSON.parse(jsonContent) as {
        name?: string;
        main?: string;
        kv_namespaces?: Array<{ binding: string; id: string }>;
        durable_objects?: { bindings: Array<{ name: string; class_name: string }> };
        migrations?: Array<{ tag: string; new_sqlite_classes?: string[] }>;
        vars?: Record<string, string>;
      };

      expect(config.main).toBe('src/index.ts');

      // KV binding
      expect(config.kv_namespaces).toBeDefined();
      const hasMessagesKv = config.kv_namespaces?.some((kv) => kv.binding === 'MESSAGES_KV');
      expect(hasMessagesKv).toBe(true);

      // DO binding
      expect(config.durable_objects?.bindings).toBeDefined();
      const doBinding = config.durable_objects?.bindings.find(
        (b) => b.name === 'FALLBACK_TIMER' && b.class_name === 'FallbackTimer'
      );
      expect(doBinding).toBeDefined();

      // SQLite migration for FallbackTimer
      expect(config.migrations).toBeDefined();
      const hasMigration = config.migrations?.some(
        (m) => m.new_sqlite_classes && m.new_sqlite_classes.includes('FallbackTimer')
      );
      expect(hasMigration).toBe(true);

      // Unsigned dev webhooks, so the README's curl commands work out of the box
      expect(config.vars?.MESSAGING_DEV_UNSIGNED).toBe('true');
    });

    it('exports FallbackTimer, runs createMessagingApp at module scope, and uses only console providers with no credentials', () => {
      const indexPath = path.join(exampleDir, 'src/index.ts');
      const indexContent = fs.readFileSync(indexPath, 'utf8');

      // Exports FallbackTimer
      expect(indexContent).toMatch(/export\s+\{\s*FallbackTimer\s*\}\s+from/);

      // Runs createMessagingApp at module scope (not inside a fetch handler)
      expect(indexContent).toMatch(/const\s+app\s*=\s*createMessagingApp/);
      expect(indexContent).toMatch(/export\s+default\s+app/);

      // No external vendor providers or credentials
      expect(indexContent).not.toContain('metaWhatsApp');
      expect(indexContent).not.toContain('httpSms');
      expect(indexContent).not.toContain('gmail');
      expect(indexContent).not.toContain('WHATSAPP_TOKEN');
      expect(indexContent).not.toContain('GMAIL_CLIENT_ID');
      expect(indexContent).not.toContain('SMS_GATEWAY_KEY');

      // Uses consoleProvider on all channels
      expect(indexContent).toContain('consoleProvider');
      expect(indexContent).toContain("channel: 'whatsapp'");
      expect(indexContent).toContain("channel: 'sms'");
      expect(indexContent).toContain("channel: 'email'");
    });
  });

  describe('Miniflare runtime execution', () => {
    let mf: Miniflare;

    beforeAll(async () => {
      const script = await buildExampleWorker();
      mf = new Miniflare(
        convertV4MiniflareOptions({
          modules: true,
          script,
          compatibilityDate: '2026-07-16',
          compatibilityFlags: ['nodejs_compat'],
          kvNamespaces: ['MESSAGES_KV'],
          durableObjects: { FALLBACK_TIMER: { className: 'FallbackTimer', useSQLite: true } },
          bindings: {
            MESSAGING_DEV_UNSIGNED: 'true',
            MESSAGES_ENC_KEY: TEST_ENC_KEY,
          },
        })
      );
      await mf.ready;
    });

    afterAll(async () => {
      await mf.dispose();
    });

    async function post(pathname: string, body?: unknown): Promise<Response> {
      return mf.dispatchFetch(`https://worker.test${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }) as unknown as Promise<Response>;
    }

    async function get(pathname: string): Promise<Response> {
      return mf.dispatchFetch(`https://worker.test${pathname}`) as unknown as Promise<Response>;
    }

    async function waitForRecord(
      id: string,
      isSettled: (record: MessageRecord) => boolean,
      timeoutMs = 5000
    ): Promise<MessageRecord> {
      const deadline = Date.now() + timeoutMs;
      let res = await get(`/status/${id}`);
      let record = (await res.json()) as MessageRecord;
      while (!isSettled(record) && Date.now() < deadline) {
        await sleep(50);
        res = await get(`/status/${id}`);
        record = (await res.json()) as MessageRecord;
      }
      return record;
    }

    it('sends a notification template (fallback chain + always-on), fetches status, and advances / completes via webhooks', async () => {
      // 1. POST /send for notification template
      const sendRes = await post('/send', {
        template: 'orderUpdate',
        to: '+1771234567',
        email: 'shopper@example.com',
        locale: 'en',
        input: {
          orderId: 'ORD-9988',
          status: 'Shipped',
        },
      });

      expect(sendRes.status).toBe(200);
      const sendBody = (await sendRes.json()) as { id: string };
      expect(sendBody.id).toBeDefined();
      expect(sendBody.id.startsWith('msg_')).toBe(true);
      const id = sendBody.id;

      // 2. GET /status/:id returns record with WhatsApp (sent) in chain and Email (sent) in always
      const initialRecord = await waitForRecord(
        id,
        (r) => r.chain.attempts.length === 1 && r.always.length === 1
      );
      expect(initialRecord.template).toBe('orderUpdate');
      expect(initialRecord.kind).toBe('notification');
      expect(initialRecord.chain.attempts[0].channel).toBe('whatsapp');
      expect(initialRecord.chain.attempts[0].status).toBe('sent');
      expect(initialRecord.always[0].channel).toBe('email');
      expect(initialRecord.always[0].status).toBe('sent');
      expect(initialRecord.chain.status).toBe('sent');

      // 3. POST webhook simulating failed WhatsApp delivery -> advances fallback chain to SMS
      const waWebhookRes = await post('/webhooks/console-whatsapp', {
        providerId: `console_${id}`,
        status: 'failed',
      });
      expect(waWebhookRes.status).toBe(200);

      const advancedRecord = await waitForRecord(id, (r) => r.chain.attempts.length === 2);
      expect(advancedRecord.chain.attempts[0].channel).toBe('whatsapp');
      expect(advancedRecord.chain.attempts[0].status).toBe('failed');
      expect(advancedRecord.chain.attempts[1].channel).toBe('sms');
      expect(advancedRecord.chain.attempts[1].status).toBe('sent');
      expect(advancedRecord.chain.status).toBe('sent');

      // 4. POST webhook simulating delivered SMS -> completes the fallback chain
      const smsWebhookRes = await post('/webhooks/console-sms', {
        providerId: `console_${id}`,
        status: 'delivered',
      });
      expect(smsWebhookRes.status).toBe(200);

      const completedRecord = await waitForRecord(id, (r) => r.chain.status === 'delivered');
      expect(completedRecord.chain.status).toBe('delivered');
      expect(completedRecord.status).toBe('delivered');
    });

    it('sends an OTP template and successfully delivers via webhook', async () => {
      // 1. POST /send for OTP template
      const sendRes = await post('/send', {
        template: 'loginCode',
        to: '+1779998888',
        locale: 'en',
        input: {
          code: '839201',
        },
      });

      expect(sendRes.status).toBe(200);
      const { id } = (await sendRes.json()) as { id: string };
      expect(id).toBeDefined();

      // 2. GET /status/:id
      const record = await waitForRecord(id, (r) => r.chain.attempts.length === 1);
      expect(record.template).toBe('loginCode');
      expect(record.kind).toBe('otp');
      // The SMS fallback the example's docs promise is real: `loginCode` renders for SMS, so
      // `resolveDelivery` keeps it in the chain instead of dropping it.
      expect(record.policy.fallback).toEqual(['whatsapp', 'sms']);
      expect(record.chain.attempts[0].channel).toBe('whatsapp');
      expect(record.always).toHaveLength(0);

      // 3. POST webhook delivering WhatsApp code
      const waWebhookRes = await post('/webhooks/console-whatsapp', {
        providerId: `console_${id}`,
        status: 'delivered',
      });
      expect(waWebhookRes.status).toBe(200);

      const deliveredRecord = await waitForRecord(id, (r) => r.chain.status === 'delivered');
      expect(deliveredRecord.chain.status).toBe('delivered');
    });
  });
});
