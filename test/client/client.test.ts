/**
 * Tests for createMessagingClient: typed sends over a service binding (Issue #12).
 *
 * Acceptance criteria:
 * - Runtime tests with a fake Fetcher: request path and body shape for send with and without delivery;
 *   200, 400 and 500 handling; status for found and not found.
 * - BasePath normalization: defaults to '/' and handles custom prefixes.
 * - Error handling: non-2xx responses map to { ok: false, status, error } and never throw;
 *   network errors from the binding fetch do throw.
 * - status(id): GET <basePath>/status/:id returning MessageRecord or null on 404.
 * - Bundle check: importing messagefall-workers/client pulls in no provider code.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createMessagingClient } from '../../src/client/index.js';
import type { MessageRecord } from '../../src/core/status.js';
import { defineTemplates } from '../../src/templates.js';
import { createMockFetcher, rejection } from '../helpers/client.js';

const rootDir = path.resolve(import.meta.dir, '../..');

// Helper to walk relative ESM imports in built dist files
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
    if (!fs.existsSync(file)) throw new Error(`Import graph reached a missing file: ${file}`);
    seen.add(file);
    queue.push(...relativeImportsOf(file));
  }
  return seen;
}

describe('createMessagingClient runtime behavior (Issue #12)', () => {
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
      sms: ({ title, url }: { title: string; url: string }) => `Match: ${title} ${url}`,
      email: {
        subject: ({ title }: { title: string }) => `Match: ${title}`,
        text: ({ title, url }: { title: string; url: string }) => `${title}\n${url}`,
      },
    },
    smsOnly: {
      input: z.object({ message: z.string() }),
      kind: 'notification',
      sms: ({ message }: { message: string }) => message,
    },
  });

  type TestCatalog = typeof testTemplates;

  describe('send request path and basePath normalization', () => {
    it('posts to https://messaging/send by default when basePath is omitted', async () => {
      expect(testTemplates).toBeDefined();
      const fetcher = createMockFetcher((req) => {
        expect(req.method).toBe('POST');
        expect(req.url).toBe('https://messaging/send');
        expect(req.headers.get('content-type')).toContain('application/json');
        return Response.json({ id: 'msg_01J8TEST001' }, { status: 200 });
      });

      const client = createMessagingClient<TestCatalog>({ binding: fetcher });
      const result = await client.send('loginCode', {
        to: '+94770000001',
        locale: 'en',
        input: { code: '123456' },
      });

      expect(fetcher.requests).toHaveLength(1);
      expect(result).toEqual({ ok: true, id: 'msg_01J8TEST001' });
    });

    it('normalizes basePath when specified with leading or trailing slashes', async () => {
      const testCases = [
        { basePath: '/api/v1', expectedPath: 'https://messaging/api/v1/send' },
        { basePath: '/api/v1/', expectedPath: 'https://messaging/api/v1/send' },
        { basePath: 'api/v1', expectedPath: 'https://messaging/api/v1/send' },
        { basePath: '/', expectedPath: 'https://messaging/send' },
      ];

      for (const { basePath, expectedPath } of testCases) {
        const fetcher = createMockFetcher((req) => {
          expect(req.url).toBe(expectedPath);
          return Response.json({ id: 'msg_01J8TEST002' }, { status: 200 });
        });

        const client = createMessagingClient<TestCatalog>({
          binding: fetcher,
          basePath,
        });

        const result = await client.send('loginCode', {
          to: '+94770000001',
          locale: 'en',
          input: { code: '123456' },
        });

        expect(result).toEqual({ ok: true, id: 'msg_01J8TEST002' });
      }
    });
  });

  describe('send request JSON body shape', () => {
    it('sends correct JSON payload without delivery override', async () => {
      let receivedBody: unknown;
      const fetcher = createMockFetcher(async (req) => {
        receivedBody = await req.json();
        return Response.json({ id: 'msg_01J8BODY001' }, { status: 200 });
      });

      const client = createMessagingClient<TestCatalog>({ binding: fetcher });
      await client.send('loginCode', {
        to: '+94770000001',
        locale: 'en',
        input: { code: '654321' },
      });

      expect(receivedBody).toEqual({
        template: 'loginCode',
        to: '+94770000001',
        locale: 'en',
        input: { code: '654321' },
      });
    });

    it('sends correct JSON payload with delivery override and email', async () => {
      let receivedBody: unknown;
      const fetcher = createMockFetcher(async (req) => {
        receivedBody = await req.json();
        return Response.json({ id: 'msg_01J8BODY002' }, { status: 200 });
      });

      const client = createMessagingClient<TestCatalog>({ binding: fetcher });
      await client.send('matchFound', {
        to: '+94770000002',
        email: 'alice@example.com',
        locale: 'en',
        input: { title: 'Apartment', url: 'https://example.com/apt/1' },
        delivery: {
          fallback: ['whatsapp', 'sms'],
          always: ['email'],
        },
      });

      expect(receivedBody).toEqual({
        template: 'matchFound',
        to: '+94770000002',
        email: 'alice@example.com',
        locale: 'en',
        input: { title: 'Apartment', url: 'https://example.com/apt/1' },
        delivery: {
          fallback: ['whatsapp', 'sms'],
          always: ['email'],
        },
      });
    });

    it('sends correct JSON payload with delivery: all', async () => {
      let receivedBody: unknown;
      const fetcher = createMockFetcher(async (req) => {
        receivedBody = await req.json();
        return Response.json({ id: 'msg_01J8BODY003' }, { status: 200 });
      });

      const client = createMessagingClient<TestCatalog>({ binding: fetcher });
      await client.send('matchFound', {
        to: '+94770000002',
        locale: 'en',
        input: { title: 'Apartment', url: 'https://example.com/apt/1' },
        delivery: 'all',
      });

      expect(receivedBody).toEqual({
        template: 'matchFound',
        to: '+94770000002',
        locale: 'en',
        input: { title: 'Apartment', url: 'https://example.com/apt/1' },
        delivery: 'all',
      });
    });
  });

  describe('send HTTP response status handling', () => {
    it('handles 200 response mapping to { ok: true, id }', async () => {
      const fetcher = createMockFetcher(() => {
        return Response.json({ id: 'msg_01J8OK200' }, { status: 200 });
      });

      const client = createMessagingClient<TestCatalog>({ binding: fetcher });
      const result = await client.send('loginCode', {
        to: '+94770000001',
        locale: 'en',
        input: { code: '123456' },
      });

      expect(result).toEqual({ ok: true, id: 'msg_01J8OK200' });
    });

    it('handles 400 validation error response mapping to { ok: false, status: 400, error } without throwing', async () => {
      const fetcher = createMockFetcher(() => {
        return Response.json(
          { error: 'Template input validation failed: code must be 6 characters' },
          { status: 400 }
        );
      });

      const client = createMessagingClient<TestCatalog>({ binding: fetcher });
      const result = await client.send('loginCode', {
        to: '+94770000001',
        locale: 'en',
        input: { code: '12' },
      });

      expect(result).toEqual({
        ok: false,
        status: 400,
        error: 'Template input validation failed: code must be 6 characters',
      });
    });

    it('handles 404 unknown template error response mapping to { ok: false, status: 404, error } without throwing', async () => {
      const fetcher = createMockFetcher(() => {
        return Response.json({ error: 'Unknown template "nonExistent"' }, { status: 404 });
      });

      const client = createMessagingClient<TestCatalog>({ binding: fetcher });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await client.send('nonExistent' as any, {
        to: '+94770000001',
        locale: 'en',
        input: { code: '123456' },
      });

      expect(result).toEqual({
        ok: false,
        status: 404,
        error: 'Unknown template "nonExistent"',
      });
    });

    it('handles 422 policy error response mapping to { ok: false, status: 422, error } without throwing', async () => {
      const fetcher = createMockFetcher(() => {
        return Response.json(
          { error: 'No delivery channels available for template "smsOnly"' },
          { status: 422 }
        );
      });

      const client = createMessagingClient<TestCatalog>({ binding: fetcher });
      const result = await client.send('smsOnly', {
        to: '+94770000001',
        locale: 'en',
        input: { message: 'hello' },
      });

      expect(result).toEqual({
        ok: false,
        status: 422,
        error: 'No delivery channels available for template "smsOnly"',
      });
    });

    it('handles 500 server error response mapping to { ok: false, status: 500, error } without throwing', async () => {
      const fetcher = createMockFetcher(() => {
        return Response.json({ error: 'Internal Server Error' }, { status: 500 });
      });

      const client = createMessagingClient<TestCatalog>({ binding: fetcher });
      const result = await client.send('loginCode', {
        to: '+94770000001',
        locale: 'en',
        input: { code: '123456' },
      });

      expect(result).toEqual({
        ok: false,
        status: 500,
        error: 'Internal Server Error',
      });
    });

    it('handles non-JSON error response body gracefully without throwing', async () => {
      const fetcher = createMockFetcher(() => {
        return new Response('502 Bad Gateway', {
          status: 502,
          statusText: 'Bad Gateway',
          headers: { 'content-type': 'text/plain' },
        });
      });

      const client = createMessagingClient<TestCatalog>({ binding: fetcher });
      const result = await client.send('loginCode', {
        to: '+94770000001',
        locale: 'en',
        input: { code: '123456' },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(502);
        expect(result.error).toBeDefined();
        expect(typeof result.error).toBe('string');
      }
    });

    it('re-throws network/transport errors from binding fetch without swallowing into ok: false', async () => {
      const fetcher = createMockFetcher(() => {
        throw new TypeError('Failed to fetch: connection refused');
      });

      const client = createMessagingClient<TestCatalog>({ binding: fetcher });
      const error = await rejection(
        client.send('loginCode', {
          to: '+94770000001',
          locale: 'en',
          input: { code: '123456' },
        })
      );
      expect(error).toBeInstanceOf(TypeError);
      expect((error as TypeError).message).toContain('Failed to fetch: connection refused');
    });
  });

  describe('status(id) behavior', () => {
    it('calls GET https://messaging/status/:id for default basePath and returns MessageRecord', async () => {
      const mockRecord: MessageRecord = {
        id: 'msg_01J8STATUS001',
        template: 'loginCode',
        kind: 'otp',
        policy: { fallback: ['whatsapp', 'sms'], always: [] },
        chain: {
          status: 'delivered',
          attempts: [
            {
              channel: 'whatsapp',
              provider: 'meta-whatsapp',
              status: 'delivered',
              at: '2026-09-20T12:00:00.000Z',
            },
          ],
        },
        always: [],
        status: 'delivered',
        createdAt: '2026-09-20T12:00:00.000Z',
        updatedAt: '2026-09-20T12:00:05.000Z',
      };

      const fetcher = createMockFetcher((req) => {
        expect(req.method).toBe('GET');
        expect(req.url).toBe('https://messaging/status/msg_01J8STATUS001');
        return Response.json(mockRecord, { status: 200 });
      });

      const client = createMessagingClient<TestCatalog>({ binding: fetcher });
      const record = await client.status('msg_01J8STATUS001');

      expect(record).toEqual(mockRecord);
    });

    it('calls GET https://messaging/api/v1/status/:id when custom basePath is configured', async () => {
      const mockRecord: MessageRecord = {
        id: 'msg_01J8STATUS002',
        template: 'matchFound',
        kind: 'notification',
        policy: { fallback: ['whatsapp', 'sms'], always: ['email'] },
        chain: { status: 'sent', attempts: [] },
        always: [],
        status: 'sent',
        createdAt: '2026-09-20T12:00:00.000Z',
        updatedAt: '2026-09-20T12:00:00.000Z',
      };

      const fetcher = createMockFetcher((req) => {
        expect(req.url).toBe('https://messaging/api/v1/status/msg_01J8STATUS002');
        return Response.json(mockRecord, { status: 200 });
      });

      const client = createMessagingClient<TestCatalog>({
        binding: fetcher,
        basePath: '/api/v1',
      });
      const record = await client.status('msg_01J8STATUS002');

      expect(record).toEqual(mockRecord);
    });

    it('returns null when status endpoint returns 404 (not found)', async () => {
      const fetcher = createMockFetcher((req) => {
        expect(req.url).toBe('https://messaging/status/msg_unknown_id');
        return Response.json({ error: 'Message record not found: msg_unknown_id' }, { status: 404 });
      });

      const client = createMessagingClient<TestCatalog>({ binding: fetcher });
      const record = await client.status('msg_unknown_id');

      expect(record).toBeNull();
    });

    it('re-throws network errors during status lookup', async () => {
      const fetcher = createMockFetcher(() => {
        throw new Error('Service binding timeout');
      });

      const client = createMessagingClient<TestCatalog>({ binding: fetcher });
      const error = await rejection(client.status('msg_timeout'));
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Service binding timeout');
    });
  });

  describe('bundle check: importing messagefall-workers/client pulls in no provider code', () => {
    beforeAll(() => {
      const buildResult = spawnSync('bun', ['run', 'build'], {
        cwd: rootDir,
        encoding: 'utf8',
      });
      if (buildResult.status !== 0) {
        throw new Error(`bun run build failed:\n${buildResult.stdout}\n${buildResult.stderr}`);
      }
    });

    it('ensures dist/client/index.js imports only type definitions and no provider code', () => {
      const clientDist = path.join(rootDir, 'dist/client/index.js');
      expect(fs.existsSync(clientDist)).toBe(true);

      const reachableFiles = walkImportGraph([clientDist]);
      const providerOffenders = [...reachableFiles].filter(
        (file) => file.includes(path.sep + 'providers' + path.sep) || file.includes('meta-whatsapp')
      );

      expect(providerOffenders).toEqual([]);
    });

    it('ensures dist/client/index.js does not import heavy core runtime modules', () => {
      const clientDist = path.join(rootDir, 'dist/client/index.js');
      const reachableFiles = walkImportGraph([clientDist]);

      const coreOffenders = [...reachableFiles].filter(
        (file) =>
          file.includes(path.join('core', 'messaging.js')) ||
          file.includes(path.join('core', 'send.js')) ||
          file.includes(path.join('core', 'fallback.js')) ||
          file.includes(path.join('core', 'webhook.js'))
      );

      expect(coreOffenders).toEqual([]);
    });
  });
});
