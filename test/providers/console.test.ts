/**
 * Tests for the Provider contract and the console provider (Issue #18).
 *
 * Acceptance criteria:
 * - Types exported and documented with JSDoc on every field.
 * - Console provider send test: logs contain recipient and channel; for an `otp` message
 *   the rendered text is absent from captured output.
 * - Simulated status test: with `simulate: { status: 'failed', afterMs: 10 }`, the hook
 *   receives a `failed` event for the returned `providerId`.
 * - Provider contract shape, optional status() / statusHandler(), and startup validation
 *   rejecting duplicate names or missing required fields with a bulleted error list.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'bun:test';

import { createMessaging } from '../../src/index.js';
import { captureConsole, newEnv, pingTemplates } from '../helpers/messaging.js';
import type {
  Channel,
  DeliveryStatus,
  OutboundMeta,
  Provider,
  RenderedEmail,
  RenderedSms,
  RenderedWhatsApp,
  StatusEvent,
} from './types.js';

const rootDir = path.resolve(import.meta.dir, '../..');

type AnyRendered = RenderedSms | RenderedWhatsApp | RenderedEmail | Record<string, unknown>;

/**
 * Dynamically loads the console provider entry point if it exists.
 */
async function loadConsoleProvider(): Promise<
  | ((options: {
      channel: Channel;
      name?: string;
      simulate?: { status: 'delivered' | 'failed'; afterMs: number };
    }) => Provider<AnyRendered> & {
      onSimulatedStatus?: (event: StatusEvent) => void;
      status?: (messageId: string) => Promise<unknown>;
      statusHandler?: (request: Request) => Promise<Response> | Response;
    })
  | undefined
> {
  try {
    const consoleEntry = '../../src/providers/console/index.js';
    const mod = (await import(consoleEntry)) as {
      consoleProvider?: (options: {
        channel: Channel;
        name?: string;
        simulate?: { status: 'delivered' | 'failed'; afterMs: number };
      }) => Provider<AnyRendered>;
      default?: (options: {
        channel: Channel;
        name?: string;
        simulate?: { status: 'delivered' | 'failed'; afterMs: number };
      }) => Provider<AnyRendered>;
    };
    return mod.consoleProvider ?? mod.default;
  } catch {
    return undefined;
  }
}

describe('Provider types and JSDoc documentation', () => {
  it('exports required types from src/providers/types.ts and root entry', () => {
    const typesPath = path.join(rootDir, 'src/providers/types.ts');
    const typesContent = fs.readFileSync(typesPath, 'utf8');

    // Verify type and interface declarations exist in src/providers/types.ts
    expect(typesContent).toContain('export type Channel');
    expect(typesContent).toContain('export type DeliveryStatus');
    expect(typesContent).toContain('export interface StatusEvent');
    expect(typesContent).toContain('export interface OutboundMeta');
    expect(typesContent).toContain('export interface RenderedWhatsApp');
    expect(typesContent).toContain('export interface RenderedSms');
    expect(typesContent).toContain('export interface RenderedEmail');
    expect(typesContent).toContain('export type SendResult');
    expect(typesContent).toContain('export interface Provider');

    // Verify root entry re-exports provider types
    const rootPath = path.join(rootDir, 'src/index.ts');
    const rootContent = fs.readFileSync(rootPath, 'utf8');
    expect(rootContent).toContain("export * from './providers/index.js'");
  });

  it('documents every field with JSDoc on provider types and documents missing webhook behavior', () => {
    const typesPath = path.join(rootDir, 'src/providers/types.ts');
    const content = fs.readFileSync(typesPath, 'utf8');

    // StatusEvent field documentation
    expect(content).toMatch(/\/\*\*[\s\S]*?\*\/\s*providerId:\s*string/);
    expect(content).toMatch(/\/\*\*[\s\S]*?\*\/\s*status:\s*DeliveryStatus/);
    expect(content).toMatch(/\/\*\*[\s\S]*?\*\/\s*error\?:\s*string/);
    expect(content).toMatch(/\/\*\*[\s\S]*?\*\/\s*at:\s*string/);

    // OutboundMeta field documentation
    expect(content).toMatch(/\/\*\*[\s\S]*?\*\/\s*to:\s*string/);
    expect(content).toMatch(/\/\*\*[\s\S]*?\*\/\s*messageId:\s*string/);
    expect(content).toMatch(/\/\*\*[\s\S]*?\*\/\s*template:\s*string/);
    expect(content).toMatch(/\/\*\*[\s\S]*?\*\/\s*kind:\s*'otp'\s*\|\s*'notification'/);
    expect(content).toMatch(/\/\*\*[\s\S]*?\*\/\s*locale:\s*string/);

    // Rendered WhatsApp / SMS / Email field documentation
    expect(content).toMatch(/\/\*\*[\s\S]*?\*\/\s*template\?:/);
    expect(content).toMatch(/\/\*\*[\s\S]*?\*\/\s*text\?:/);
    expect(content).toMatch(/\/\*\*[\s\S]*?\*\/\s*subject:/);
    expect(content).toMatch(/\/\*\*[\s\S]*?\*\/\s*html\?:/);

    // Provider interface field documentation
    expect(content).toMatch(/\/\*\*[\s\S]*?\*\/\s*name:\s*string/);
    expect(content).toMatch(/\/\*\*[\s\S]*?\*\/\s*channel:\s*Channel/);
    expect(content).toMatch(/\/\*\*[\s\S]*?\*\/\s*send\(/);

    // Document in a code comment that a provider without webhook leaves attempts at sent until chain timeout
    expect(content.toLowerCase()).toContain('timeout');
    expect(content.toLowerCase()).toContain('webhook');
  });
});

describe('Console provider send test', () => {
  it('exports consoleProvider function from ./providers/console entry', async () => {
    const consoleProvider = await loadConsoleProvider();
    expect(typeof consoleProvider).toBe('function');
  });

  it('logs recipient, channel, template, and messageId on send', async () => {
    const consoleProvider = await loadConsoleProvider();
    expect(consoleProvider).toBeDefined();

    const provider = consoleProvider ? consoleProvider({ channel: 'sms' }) : null;
    expect(provider).not.toBeNull();
    if (!provider) return;

    expect(provider.channel).toBe('sms');
    expect(provider.name).toBe('console');

    const capture = captureConsole();
    try {
      const message: RenderedSms & OutboundMeta = {
        to: '+94771234567',
        messageId: 'msg_test_001',
        template: 'orderUpdate',
        kind: 'notification',
        locale: 'en',
        text: 'Your order #100 has been confirmed.',
      };

      const result = await provider.send(message);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.providerId).toBe('console_msg_test_001');
      }

      const allLogs = capture.logs.join(' ');
      expect(allLogs).toContain('+94771234567');
      expect(allLogs).toContain('sms');
      expect(allLogs).toContain('orderUpdate');
      expect(allLogs).toContain('msg_test_001');
    } finally {
      capture.restore();
    }
  });

  it('never logs rendered text or secret content when message kind is otp', async () => {
    const consoleProvider = await loadConsoleProvider();
    expect(consoleProvider).toBeDefined();

    const provider = consoleProvider ? consoleProvider({ channel: 'sms' }) : null;
    expect(provider).not.toBeNull();
    if (!provider) return;

    const capture = captureConsole();
    try {
      const secretCode = 'SECRET-OTP-884219';
      const message: RenderedSms & OutboundMeta = {
        to: '+94779876543',
        messageId: 'msg_otp_secret_002',
        template: 'loginCode',
        kind: 'otp',
        locale: 'en',
        text: `Your security code is ${secretCode}. Do not share it.`,
      };

      const result = await provider.send(message);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.providerId).toBe('console_msg_otp_secret_002');
      }

      const allLogs = capture.logs.join(' ');
      // Metadata must be logged
      expect(allLogs).toContain('+94779876543');
      expect(allLogs).toContain('sms');
      expect(allLogs).toContain('loginCode');
      expect(allLogs).toContain('msg_otp_secret_002');

      // Sensitive rendered text must NOT appear anywhere in logs
      expect(allLogs).not.toContain(secretCode);
      expect(allLogs).not.toContain('Your security code is');
    } finally {
      capture.restore();
    }
  });

  it('never logs WhatsApp template parameters or free text when kind is otp', async () => {
    const consoleProvider = await loadConsoleProvider();
    expect(consoleProvider).toBeDefined();

    const provider = consoleProvider ? consoleProvider({ channel: 'whatsapp' }) : null;
    expect(provider).not.toBeNull();
    if (!provider) return;

    const capture = captureConsole();
    try {
      const secretParam = 'AUTH-KEY-9911';
      const message = {
        to: '+94773334444',
        messageId: 'msg_wa_otp_003',
        template: 'authTemplate',
        kind: 'otp' as const,
        locale: 'en',
        text: `Auth key: ${secretParam}`,
      };

      const result = await provider.send(message);
      expect(result.ok).toBe(true);

      const allLogs = capture.logs.join(' ');
      expect(allLogs).toContain('+94773334444');
      expect(allLogs).toContain('whatsapp');
      expect(allLogs).toContain('authTemplate');
      expect(allLogs).not.toContain(secretParam);
    } finally {
      capture.restore();
    }
  });

  it('logs the Meta template name, never params or [object Object], when template is a config object', async () => {
    const consoleProvider = await loadConsoleProvider();
    expect(consoleProvider).toBeDefined();

    const provider = consoleProvider ? consoleProvider({ channel: 'whatsapp' }) : null;
    expect(provider).not.toBeNull();
    if (!provider) return;

    const capture = captureConsole();
    try {
      const code = '774411';
      // What the send pipeline hands a WhatsApp provider for a template render: the rendered
      // config occupies `template`, not the catalogue name.
      const message = {
        to: '+94775556666',
        messageId: 'msg_wa_otp_004',
        template: { name: 'auth_code', language: 'en_US', params: [code] },
        kind: 'otp' as const,
        locale: 'en',
      } as unknown as Parameters<typeof provider.send>[0];

      const result = await provider.send(message);
      expect(result.ok).toBe(true);

      const allLogs = capture.logs.join(' ');
      expect(allLogs).toContain('template=auth_code');
      expect(allLogs).not.toContain('[object Object]');
      expect(allLogs).not.toContain(code);
    } finally {
      capture.restore();
    }
  });

  it('never logs email subject, text, or html when kind is otp', async () => {
    const consoleProvider = await loadConsoleProvider();
    expect(consoleProvider).toBeDefined();

    const provider = consoleProvider ? consoleProvider({ channel: 'email' }) : null;
    expect(provider).not.toBeNull();
    if (!provider) return;

    const capture = captureConsole();
    try {
      const secretBody = 'CONFIDENTIAL-PASSCODE-7766';
      const message: RenderedEmail & OutboundMeta = {
        to: 'user@example.com',
        messageId: 'msg_email_otp_004',
        template: 'emailOtp',
        kind: 'otp',
        locale: 'en',
        subject: 'Your one-time passcode',
        text: `Code: ${secretBody}`,
        html: `<p>Code: <b>${secretBody}</b></p>`,
      };

      const result = await provider.send(message);
      expect(result.ok).toBe(true);

      const allLogs = capture.logs.join(' ');
      expect(allLogs).toContain('user@example.com');
      expect(allLogs).toContain('email');
      expect(allLogs).toContain('emailOtp');
      expect(allLogs).not.toContain(secretBody);
      expect(allLogs).not.toContain('passcode');
    } finally {
      capture.restore();
    }
  });

  it('respects custom provider name when specified', async () => {
    const consoleProvider = await loadConsoleProvider();
    expect(consoleProvider).toBeDefined();

    const provider = consoleProvider
      ? consoleProvider({ channel: 'sms', name: 'custom-console-sms' })
      : null;
    expect(provider).not.toBeNull();
    if (!provider) return;

    expect(provider.name).toBe('custom-console-sms');
    expect(provider.channel).toBe('sms');
  });
});

describe('Simulated status test', () => {
  it('receives a failed status event for the returned providerId when simulate status is failed', async () => {
    const consoleProvider = await loadConsoleProvider();
    expect(consoleProvider).toBeDefined();

    const provider = consoleProvider
      ? consoleProvider({
          channel: 'sms',
          simulate: { status: 'failed', afterMs: 10 },
        })
      : null;
    expect(provider).not.toBeNull();
    if (!provider) return;

    const receivedEvents: StatusEvent[] = [];
    const simulatedStatusPromise = new Promise<StatusEvent>((resolve) => {
      provider.onSimulatedStatus = (event: StatusEvent) => {
        receivedEvents.push(event);
        resolve(event);
      };
    });

    const messageId = 'msg_sim_fail_001';
    const result = await provider.send({
      to: '+94770000001',
      messageId,
      template: 'testFail',
      kind: 'notification',
      locale: 'en',
      text: 'Testing failure simulation',
    });

    expect(result.ok).toBe(true);
    const expectedProviderId = `console_${messageId}`;
    if (result.ok) {
      expect(result.providerId).toBe(expectedProviderId);
    }

    // Immediately after send, the status hook should not have fired yet
    expect(receivedEvents).toHaveLength(0);

    // Wait for the simulated status callback to fire
    const event = await simulatedStatusPromise;
    expect(event).toBeDefined();
    expect(event.providerId).toBe(expectedProviderId);
    expect(event.status).toBe('failed');
    expect(typeof event.at).toBe('string');
    const timestampMs = Date.parse(event.at);
    expect(Number.isNaN(timestampMs)).toBe(false);
  });

  it('receives a delivered status event for the returned providerId when simulate status is delivered', async () => {
    const consoleProvider = await loadConsoleProvider();
    expect(consoleProvider).toBeDefined();

    const provider = consoleProvider
      ? consoleProvider({
          channel: 'whatsapp',
          simulate: { status: 'delivered', afterMs: 15 },
        })
      : null;
    expect(provider).not.toBeNull();
    if (!provider) return;

    const simulatedStatusPromise = new Promise<StatusEvent>((resolve) => {
      provider.onSimulatedStatus = (event: StatusEvent) => {
        resolve(event);
      };
    });

    const messageId = 'msg_sim_deliv_002';
    const result = await provider.send({
      to: '+94770000002',
      messageId,
      template: 'testDelivered',
      kind: 'notification',
      locale: 'en',
      text: 'Testing delivered simulation',
    });

    expect(result.ok).toBe(true);
    const expectedProviderId = `console_${messageId}`;
    if (result.ok) {
      expect(result.providerId).toBe(expectedProviderId);
    }

    const event = await simulatedStatusPromise;
    expect(event).toBeDefined();
    expect(event.providerId).toBe(expectedProviderId);
    expect(event.status).toBe('delivered');
    expect(typeof event.at).toBe('string');
  });

  it('does not dispatch simulated status event when simulate option is omitted', async () => {
    const consoleProvider = await loadConsoleProvider();
    expect(consoleProvider).toBeDefined();

    const provider = consoleProvider ? consoleProvider({ channel: 'email' }) : null;
    expect(provider).not.toBeNull();
    if (!provider) return;

    let isHookCalled = false;
    provider.onSimulatedStatus = () => {
      isHookCalled = true;
    };

    await provider.send({
      to: 'dev@example.com',
      messageId: 'msg_no_sim_003',
      template: 'testNoSim',
      kind: 'notification',
      locale: 'en',
      subject: 'No simulation',
      text: 'Direct send',
    });

    // Wait a brief duration to ensure no timer was scheduled
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(isHookCalled).toBe(false);
  });
});

describe('Provider contract shape and optional methods', () => {
  it('conforms to Provider contract shape with name, channel, and send method', async () => {
    const consoleProvider = await loadConsoleProvider();
    expect(consoleProvider).toBeDefined();

    const provider = consoleProvider ? consoleProvider({ channel: 'sms', name: 'console-sms' }) : null;
    expect(provider).not.toBeNull();
    if (!provider) return;

    expect(provider.name).toBe('console-sms');
    expect(provider.channel).toBe('sms');
    expect(typeof provider.send).toBe('function');
  });

  it('handles optional status() method when implemented by a provider', async () => {
    // Custom provider implementing optional status() per contract
    const customProvider: Provider<RenderedSms> & {
      status(messageId: string): Promise<{ status: DeliveryStatus; at: string }>;
    } = {
      name: 'custom-with-status',
      channel: 'sms',
      send: async ({ messageId }: { messageId: string }) => {
        await Promise.resolve();
        return { ok: true, providerId: `custom_${messageId}` };
      },
      status: async () => {
        await Promise.resolve();
        return {
          status: 'delivered',
          at: new Date().toISOString(),
        };
      },
    };

    expect(typeof customProvider.status).toBe('function');
    const statusResult = await customProvider.status('msg_123');
    expect(statusResult.status).toBe('delivered');
  });

  it('handles optional statusHandler() method when implemented by a provider', async () => {
    // Custom provider implementing optional statusHandler() per contract
    const customProvider: Provider<RenderedSms> & {
      statusHandler(request: Request): Promise<Response> | Response;
    } = {
      name: 'custom-with-status-handler',
      channel: 'sms',
      send: async () => {
        await Promise.resolve();
        return { ok: true };
      },
      statusHandler: (_req: Request) => new Response('STATUS_OK', { status: 200 }),
    };

    expect(typeof customProvider.statusHandler).toBe('function');
    const req = new Request('https://worker.local/webhooks/custom-with-status-handler', {
      method: 'POST',
      body: JSON.stringify({ event: 'delivered' }),
    });
    const res = await customProvider.statusHandler(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('STATUS_OK');
  });

  it('supports webhook verify and parse methods per the contract', async () => {
    const customProvider: Provider<RenderedWhatsApp> = {
      name: 'meta-whatsapp',
      channel: 'whatsapp',
      send: async ({ messageId }: { messageId: string }) => {
        await Promise.resolve();
        return { ok: true, providerId: `wamid_${messageId}` };
      },
      webhook: {
        verify: async (req: Request) => {
          await Promise.resolve();
          const url = new URL(req.url);
          if (url.searchParams.get('hub.mode') === 'subscribe') {
            return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 });
          }
          return null;
        },
        parse: async (_req: Request): Promise<StatusEvent[]> => {
          await Promise.resolve();
          return [
            {
              providerId: 'wamid_123',
              status: 'delivered',
              at: '2026-09-20T10:00:00.000Z',
            },
          ];
        },
      },
    };

    expect(customProvider.webhook).toBeDefined();
    expect(typeof customProvider.webhook?.verify).toBe('function');
    expect(typeof customProvider.webhook?.parse).toBe('function');

    // Handshake verification
    const verifyReq = new Request('https://worker.local/webhooks/meta-whatsapp?hub.mode=subscribe&hub.challenge=test_challenge');
    const verifyRes = await customProvider.webhook?.verify?.(verifyReq);
    expect(verifyRes).not.toBeNull();
    expect(await verifyRes?.text()).toBe('test_challenge');

    // Webhook parse
    const parseReq = new Request('https://worker.local/webhooks/meta-whatsapp', {
      method: 'POST',
      body: JSON.stringify({ entry: [] }),
    });
    const events = await customProvider.webhook?.parse(parseReq);
    expect(events).toBeDefined();
    expect(events?.[0].status).toBe('delivered');
    expect(events?.[0].providerId).toBe('wamid_123');
  });
});

describe('Startup provider validation', () => {
  const templates = pingTemplates;

  it('rejects duplicate provider names across configured providers with a bulleted error', () => {
    // If two providers share the same name (e.g. 'console'), startup validation must fail
    expect(() => {
      createMessaging(newEnv(), {
        templates,
        providers: () => ({
          whatsapp: {
            name: 'console',
            channel: 'whatsapp',
            send: async () => {
              await Promise.resolve();
              return { ok: true };
            },
          },
          sms: {
            name: 'console',
            channel: 'sms',
            send: async () => {
              await Promise.resolve();
              return { ok: true };
            },
          },
        }),
      });
    }).toThrow(/duplicate provider name.*console/i);
  });

  it('rejects a provider missing a required field (name, channel, send) with a bulleted error', () => {
    expect(() => {
      createMessaging(newEnv(), {
        templates,
        providers: () => ({
          // @ts-expect-error -- deliberately malformed provider
          sms: {
            // missing name and send
            channel: 'sms',
          },
        }),
      });
    }).toThrow(/missing required/i);
  });

  it('rejects a provider whose channel does not match the slot it is registered under', () => {
    expect(() => {
      createMessaging(newEnv(), {
        templates,
        providers: () => ({
          sms: {
            name: 'mislabelled',
            channel: 'whatsapp' as 'sms',
            send: async () => {
              await Promise.resolve();
              return { ok: true };
            },
          },
        }),
      });
    }).toThrow(/"sms".*"whatsapp".*"sms"/);
  });

  it('rejects a provider registered under a slot that is not a channel', () => {
    expect(() => {
      createMessaging(newEnv(), {
        templates,
        providers: () =>
          ({
            push: {
              name: 'push-thing',
              channel: 'sms',
              send: async () => {
                await Promise.resolve();
                return { ok: true };
              },
            },
          }) as unknown as ReturnType<Parameters<typeof createMessaging>[1]['providers']>,
      });
    }).toThrow(/slot "push" is not a channel/);
  });

  it('lists every validation problem at once in a bulleted error message', () => {
    let thrownError: Error | null = null;
    try {
      createMessaging(newEnv(), {
        templates,
        providers: () => ({
          // @ts-expect-error -- deliberately malformed provider
          whatsapp: {
            // missing channel and send
            name: 'dup-name',
          },
          // @ts-expect-error -- deliberately malformed provider
          sms: {
            // duplicate name 'dup-name' and missing send
            name: 'dup-name',
            channel: 'sms',
          },
        }),
      });
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).not.toBeNull();
    expect(thrownError?.message).toBeDefined();
    // Bulleted format should list multiple problems (e.g. lines beginning with '- ' or '* ')
    const lines = thrownError?.message.split('\n') ?? [];
    const bulletLines = lines.filter((l) => l.trimStart().startsWith('-') || l.trimStart().startsWith('*'));
    expect(bulletLines.length).toBeGreaterThanOrEqual(2);
  });
});
