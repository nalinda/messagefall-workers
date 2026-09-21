/**
 * Failing tests for structural logger and zero-content leakage (GitHub Issue #10).
 *
 * Acceptance criteria:
 * - Type-level test: logger.info('anything', { text: 'x' }) does not compile;
 *   an allow-listed event with LogFields does.
 * - Integration-style test: render an otp template with code 482913 and SMS text containing it;
 *   drive a send with a provider that fails with an error message echoing the body;
 *   drive a webhook with a failed status whose error echoes the body;
 *   capture all console output and every KV value; assert 482913 and the SMS text appear in neither.
 * - All existing console.* calls in src/ are replaced by the logger
 *   (grep in CI: console\. allowed only in src/core/logger.ts and the console provider).
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  createLogger,
  type LogEvent,
  type LogFields,
  type Logger,
} from '../../src/core/logger.js';
import { createMessaging } from '../../src/core/messaging.js';
import { scrubError } from '../../src/core/redact.js';
import type { Channel, Provider, RenderedSms } from '../../src/providers/types.js';
import { defineTemplates, render } from '../../src/templates.js';
import {
  assertType,
  type Expect,
  type Extends,
  type Not,
} from '../helpers/logger.js';
import { captureConsole, memoryKV } from '../helpers/messaging.js';

interface ConsoleCallMatch {
  file: string;
  line: number;
  code: string;
}

const CONSOLE_CALL_REGEX = /\bconsole\.(?:log|info|warn|error|debug|trace|dir)\b/;

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function checkFileForConsoleCalls(filePath: string, rootDir: string): ConsoleCallMatch[] {
  const relativePath = path.relative(rootDir, filePath).replaceAll('\\', '/');
  if (relativePath === 'src/core/logger.ts' || relativePath.startsWith('src/providers/console/')) {
    return [];
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const matches: ConsoleCallMatch[] = [];
  for (const [index, line] of lines.entries()) {
    if (isCommentLine(line)) {
      continue;
    }
    if (CONSOLE_CALL_REGEX.test(line)) {
      matches.push({
        file: relativePath,
        line: index + 1,
        code: line.trim(),
      });
    }
  }
  return matches;
}

function getAllSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllSourceFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('Issue #10: No message bodies in logs, enforced in code', () => {
  describe('Acceptance Criterion 1: Type-level specifications and logger interface contract', () => {
    it('type-level test: allow-listed events compile with LogFields; non-allow-listed events and free-form fields fail', () => {
      // 1. Allow-listed events are accepted
      type TestSendStartValid = Expect<Extends<'send.start', LogEvent>>;
      type TestSendAttemptValid = Expect<Extends<'send.attempt', LogEvent>>;
      type TestWebhookAppliedValid = Expect<Extends<'webhook.applied', LogEvent>>;
      type TestFallbackAdvanceValid = Expect<Extends<'fallback.advance', LogEvent>>;
      type TestTimerArmedValid = Expect<Extends<'timer.armed', LogEvent>>;

      assertType<TestSendStartValid>(true);
      assertType<TestSendAttemptValid>(true);
      assertType<TestWebhookAppliedValid>(true);
      assertType<TestFallbackAdvanceValid>(true);
      assertType<TestTimerArmedValid>(true);

      // 2. Non-allow-listed events are rejected at compile time
      type NonAllowListedEvent = 'anything';
      type TestNonAllowListedRejected = Expect<Not<Extends<NonAllowListedEvent, LogEvent>>>;
      assertType<TestNonAllowListedRejected>(true);

      type TestArbitraryStringRejected = Expect<Not<Extends<string, LogEvent>>>;
      assertType<TestArbitraryStringRejected>(true);

      type CustomEvent = 'custom.send.event';
      type TestCustomEventRejected = Expect<Not<Extends<CustomEvent, LogEvent>>>;
      assertType<TestCustomEventRejected>(true);

      // 3. LogFields allows only structural identifier and telemetry fields
      type ValidFields = {
        id: string;
        template: string;
        kind: 'otp';
        channel: Channel;
        provider: string;
        providerId: string;
        status: 'pending';
        errorCode: string;
        count: number;
      };
      type TestValidFieldsAccepted = Expect<Extends<ValidFields, LogFields>>;
      assertType<TestValidFieldsAccepted>(true);

      // 4. Sensitive message body fields are prohibited on LogFields
      type DisallowedFieldKeys =
        | 'text'
        | 'body'
        | 'code'
        | 'subject'
        | 'params'
        | 'input'
        | 'message'
        | 'payload';
      type TestDisallowedFieldKeys = Expect<Not<Extends<DisallowedFieldKeys, keyof LogFields>>>;
      assertType<TestDisallowedFieldKeys>(true);

      // 5. Logger method signatures only accept allow-listed events and LogFields
      type LoggerInfoArgs = Parameters<Logger['info']>;
      type TestInfoSignature = Expect<Extends<[event: LogEvent, fields?: LogFields], LoggerInfoArgs>>;
      assertType<TestInfoSignature>(true);

      expect(typeof assertType).toBe('function');
    });

    it('creates a logger that formats structured JSON records to the provided sink', () => {
      const sinkLines: string[] = [];
      const logger = createLogger((line) => {
        sinkLines.push(line);
      });

      logger.info('send.start', { id: 'msg_01JABC', template: 'authOtp', kind: 'otp' });
      logger.warn('fallback.advance', { id: 'msg_01JABC', channel: 'sms', count: 1 });
      logger.error('send.attempt', { id: 'msg_01JABC', provider: 'failing-sms', errorCode: '500' });

      expect(sinkLines).toHaveLength(3);

      const parsed0 = JSON.parse(sinkLines[0]) as Record<string, unknown>;
      expect(parsed0['event']).toBe('send.start');
      expect(parsed0['id']).toBe('msg_01JABC');
      expect(parsed0['template']).toBe('authOtp');
      expect(parsed0['kind']).toBe('otp');
      expect(parsed0['level']).toBe('info');

      const parsed1 = JSON.parse(sinkLines[1]) as Record<string, unknown>;
      expect(parsed1['event']).toBe('fallback.advance');
      expect(parsed1['id']).toBe('msg_01JABC');
      expect(parsed1['channel']).toBe('sms');
      expect(parsed1['level']).toBe('warn');

      const parsed2 = JSON.parse(sinkLines[2]) as Record<string, unknown>;
      expect(parsed2['event']).toBe('send.attempt');
      expect(parsed2['id']).toBe('msg_01JABC');
      expect(parsed2['errorCode']).toBe('500');
      expect(parsed2['level']).toBe('error');
    });

    it('creates a logger with default JSON console sink when no custom sink is provided', () => {
      const { logs, restore } = captureConsole(['log', 'info', 'warn', 'error']);

      try {
        const logger = createLogger();
        logger.info('timer.armed', { id: 'msg_01JXYZ', count: 30 });

        expect(logs.length).toBeGreaterThan(0);
        const logLine = logs[0];
        const parsed = JSON.parse(logLine) as Record<string, unknown>;
        expect(parsed['event']).toBe('timer.armed');
        expect(parsed['id']).toBe('msg_01JXYZ');
        expect(parsed['count']).toBe(30);
      } finally {
        restore();
      }
    });

    it('scrubs vendor error strings removing substrings matching rendered body, code, subject, and params', () => {
      expect(typeof scrubError).toBe('function');

      const rawVendorError =
        'Vendor Gateway error: message payload "Your secret code is 482913" failed due to route error 482913';
      const sensitive = ['Your secret code is 482913', '482913'];

      const scrubbed = scrubError(rawVendorError, sensitive);
      expect(scrubbed).toBeDefined();
      expect(scrubbed).not.toContain('482913');
      expect(scrubbed).not.toContain('Your secret code is 482913');
    });

    // Regression: every number and boolean in the input used to be collected as a redaction
    // target with no length floor, so `{ retries: 4 }` turned "400 Bad Request" into
    // "[redacted]00 Bad Request" — the same hazard metadata values pose, from the input side.
    it('leaves short numbers and booleans in the input out of the redaction targets', () => {
      const scrubbed = scrubError('400 Bad Request (retryable: true, attempt 2 of 3)', {
        retries: 4,
        attempt: 2,
        retryable: true,
      });

      expect(scrubbed).toBe('400 Bad Request (retryable: true, attempt 2 of 3)');
    });

    it('still redacts a numeric code long enough to be message content', () => {
      const scrubbed = scrubError('Gateway rejected body "Your code is 482913"', { code: 482_913 });

      expect(scrubbed).not.toContain('482913');
    });

    // Regression: the scrubber used to be handed the whole provider payload — OutboundMeta's
    // `to`, `messageId`, `template`, `kind` and `locale` included — and redacted every
    // occurrence of each. "Token expired" came back as "T[redacted]n expired" because "to" is
    // a substring of "Token". Only content is sensitive; metadata is not, and must survive.
    it('leaves an ordinary vendor error intact while still redacting the message content', async () => {
      const code = '482913';
      const otpCatalog = defineTemplates({
        loginOtp: {
          input: z.object({ code: z.string().length(6) }),
          kind: 'otp' as const,
          sms: ({ code: c }: { code: string }) => `Your login code is ${c}`,
        },
      });

      const failingSms: Provider<RenderedSms> = {
        name: 'to-sms',
        channel: 'sms',
        // Every ordinary word here shares a substring with a metadata field the scrubber used
        // to be fed: "to" (the recipient), "en" (the locale), "otp" (the kind).
        send: () =>
          Promise.resolve({
            ok: false,
            error: `Token expired: the tenant gateway rejected "Your login code is ${code}"`,
          }),
      };

      const messaging = createMessaging(
        { MESSAGES_KV: memoryKV() },
        {
          templates: otpCatalog,
          providers: () => ({ sms: failingSms }),
          delivery: { fallback: ['sms'], always: [] },
        },
      );

      const { id } = await messaging.send({
        template: 'loginOtp',
        to: '+14155550123',
        locale: 'en',
        input: { code },
      });

      const record = await messaging.status(id);
      const storedError = record!.chain.attempts[0].error ?? '';

      // The content and the code are gone...
      expect(storedError).not.toContain(code);
      expect(storedError).not.toContain('Your login code is');
      expect(storedError).toContain('[redacted]');
      // ...and the vendor's own words came through unmangled.
      expect(storedError).toContain('Token expired');
      expect(storedError).toContain('the tenant gateway rejected');
    });
  });

  describe('Acceptance Criterion 2: Integration-style zero-content leakage test', () => {
    it('render an otp template with code 482913; drive send with failing provider echoing body; drive webhook with failed status echoing body; assert 482913 and SMS text appear in neither console output nor KV', async () => {
      const code = '482913';

      // 1. Render an OTP template with known code and SMS text containing it
      const otpCatalog = defineTemplates({
        authOtp: {
          input: z.object({ code: z.string().length(6) }),
          kind: 'otp' as const,
          sms: ({ code }: { code: string }) =>
            `Your verification code is ${code}. Do not share this code with anyone.`,
        },
      });

      const rendered = render(otpCatalog.authOtp, 'sms', { code }, 'en') as RenderedSms;
      const smsText = rendered.text;
      expect(smsText).toContain(code);
      expect(smsText).toBe('Your verification code is 482913. Do not share this code with anyone.');

      const kv = memoryKV();
      const env = { MESSAGES_KV: kv };

      // 2. Provider that fails and echoes the rendered SMS body and code in its error message
      const failingSmsProvider: Provider<RenderedSms> = {
        name: 'echo-failing-sms',
        channel: 'sms',
        send: (_msg) =>
          Promise.resolve({
            ok: false,
            error: `Vendor SMS Gateway 500: Failed sending message body "${smsText}" with code ${code}`,
            errorCode: 'CARRIER_REJECTED',
            providerId: 'prov_fail_001',
          }),
        webhook: {
          parse: () =>
            Promise.resolve([
              {
                providerId: 'prov_fail_001',
                status: 'failed',
                error: `Downstream carrier report: body "${smsText}" and code ${code} was dropped by network`,
                errorCode: 'DLR_DROPPED',
                at: new Date().toISOString(),
              },
            ]),
        },
      };

      const messaging = createMessaging(env, {
        templates: otpCatalog,
        providers: () => ({ sms: failingSmsProvider }),
        kv,
        delivery: { fallback: ['sms'], always: [] },
      });

      // 3. Capture ALL console output for the duration of send and webhook flows
      const { logs, restore } = captureConsole(['log', 'info', 'warn', 'error']);

      try {
        // Drive send with the failing provider
        await messaging.send({
          template: 'authOtp',
          to: '+14155550199',
          locale: 'en',
          input: { code },
        });

        // Drive webhook with failed status whose error echoes the body
        const webhookRequest = new Request('https://example.com/webhooks/echo-failing-sms', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event: 'delivery_failure', id: 'prov_fail_001' }),
        });

        await messaging.handleWebhook('echo-failing-sms', webhookRequest);
      } finally {
        restore();
      }

      // 4. Assert 482913 and the rendered SMS text appear in NO console output line
      for (const line of logs) {
        expect(line).not.toContain(code);
        expect(line).not.toContain(smsText);
      }

      // 5. Assert 482913 and the rendered SMS text appear in NO KV stored value
      const kvDump = kv.dump();
      expect(kvDump.size).toBeGreaterThan(0);
      for (const [, value] of kvDump) {
        expect(value).not.toContain(code);
        expect(value).not.toContain(smsText);
      }
    });
  });

  describe('Acceptance Criterion 3: Static analysis grep test for console.* calls under src/', () => {
    it('asserts every console.* call under src/ lives only in src/core/logger.ts or the console provider', () => {
      const rootDir = path.resolve(import.meta.dir, '../../');
      const srcDir = path.join(rootDir, 'src');

      const allFiles = getAllSourceFiles(srcDir);
      const offendingCalls: ConsoleCallMatch[] = [];

      for (const file of allFiles) {
        const fileMatches = checkFileForConsoleCalls(file, rootDir);
        offendingCalls.push(...fileMatches);
      }

      // In the RED phase, this assertion will fail because src/core/send.ts and
      // src/core/webhook.ts currently contain raw console.* calls.
      expect(offendingCalls).toEqual([]);
    });
  });
});
