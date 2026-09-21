/**
 * Tests for email channel rendering and send pipeline integration (GitHub Issue #11).
 *
 * Acceptance criteria:
 * - A notification template with an email rendering sends through the console provider as a
 *   chain channel and as an always channel, with the correct subject and text.
 * - A send whose policy includes email but supplies no address skips email, logs a
 *   send.channel-skipped event, and still sends the phone channels normally.
 * - html is optional on RenderedEmail and passed through untouched when the template defines
 *   it, absent when it doesn't.
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { createMessaging } from '../../src/core/messaging.js';
import { consoleProvider } from '../../src/providers/console/index.js';
import type { RenderedEmail, RenderedSms, RenderedWhatsApp } from '../../src/providers/types.js';
import { definedChannels, defineTemplates, render } from '../../src/templates.js';
import { captureConsole, newEnv, recordingProvider } from '../helpers/messaging.js';

const TO = '+14155550123';
const EMAIL = 'alice@example.com';

const notificationSchema = z.object({
  name: z.string(),
  orderId: z.string(),
});
type NotificationInput = z.infer<typeof notificationSchema>;

const emailCatalog = defineTemplates({
  orderWithHtml: {
    input: notificationSchema,
    kind: 'notification' as const,
    whatsapp: {
      text: ({ name, orderId }: NotificationInput, locale: string) =>
        `[${locale}] ${name}, order ${orderId} has shipped`,
    },
    sms: ({ name, orderId }: NotificationInput) => `${name}: order ${orderId} shipped`,
    email: {
      subject: ({ orderId }: NotificationInput, locale: string) => `[${locale}] Order ${orderId} shipped`,
      text: ({ name, orderId }: NotificationInput) => `Hi ${name}, your order ${orderId} is on its way.`,
      html: ({ name, orderId }: NotificationInput) => `<h1>Hi ${name}</h1><p>Your order <strong>${orderId}</strong> is on its way.</p>`,
    },
  },
  orderTextOnly: {
    input: notificationSchema,
    kind: 'notification' as const,
    whatsapp: {
      text: ({ name, orderId }: NotificationInput) => `${name}, order ${orderId} has shipped`,
    },
    sms: ({ name, orderId }: NotificationInput) => `${name}: order ${orderId} shipped`,
    email: {
      subject: ({ orderId }: NotificationInput) => `Order ${orderId} update`,
      text: ({ name, orderId }: NotificationInput) => `Hi ${name}, your order ${orderId} status updated.`,
    },
  },
  emailOnlyNotification: {
    input: z.object({ subject: z.string(), body: z.string() }),
    kind: 'notification' as const,
    email: {
      subject: ({ subject }: { subject: string }) => subject,
      text: ({ body }: { body: string }) => body,
    },
  },
});

function messagingWithEmail(): ReturnType<typeof createMessaging> {
  return createMessaging(newEnv(), {
    templates: emailCatalog,
    providers: () => ({
      whatsapp: recordingProvider<RenderedWhatsApp>('whatsapp', 'wa'),
      sms: recordingProvider<RenderedSms>('sms', 'sms-provider'),
      email: recordingProvider<RenderedEmail>('email', 'email-provider'),
    }),
    delivery: { fallback: ['whatsapp'], always: ['email'] },
  });
}

describe('Issue #11: Email channel rendering', () => {
  describe('RenderedEmail shape and template rendering', () => {
    it('produces { subject, text } with html absent when template does not define html', () => {
      const rendered = render(
        emailCatalog.orderTextOnly,
        'email',
        { name: 'Ann', orderId: 'ORD-123' },
        'en'
      ) as RenderedEmail;

      expect(rendered.subject).toBe('Order ORD-123 update');
      expect(rendered.text).toBe('Hi Ann, your order ORD-123 status updated.');
      expect('html' in rendered).toBe(false);
      expect(rendered.html).toBeUndefined();
    });

    it('produces { subject, text, html } with html passed through untouched when template defines html', () => {
      const rendered = render(
        emailCatalog.orderWithHtml,
        'email',
        { name: 'Bob', orderId: 'ORD-456' },
        'en'
      ) as RenderedEmail;

      expect(rendered.subject).toBe('[en] Order ORD-456 shipped');
      expect(rendered.text).toBe('Hi Bob, your order ORD-456 is on its way.');
      expect('html' in rendered).toBe(true);
      expect(rendered.html).toBe('<h1>Hi Bob</h1><p>Your order <strong>ORD-456</strong> is on its way.</p>');
    });

    it('passes locale through to subject, text, and html functions', () => {
      const localizedCatalog = defineTemplates({
        localizedEmail: {
          input: z.object({ code: z.string() }),
          kind: 'notification' as const,
          email: {
            subject: ({ code }: { code: string }, locale: string) => `[${locale}] Code: ${code}`,
            text: ({ code }: { code: string }, locale: string) => `[${locale}] text ${code}`,
            html: ({ code }: { code: string }, locale: string) => `<p>[${locale}] html ${code}</p>`,
          },
        },
      });

      const renderedFr = render(localizedCatalog.localizedEmail, 'email', { code: 'ABC' }, 'fr') as RenderedEmail;
      expect(renderedFr.subject).toBe('[fr] Code: ABC');
      expect(renderedFr.text).toBe('[fr] text ABC');
      expect(renderedFr.html).toBe('<p>[fr] html ABC</p>');
    });

    it('throws when rendering email channel for a template that does not define email', () => {
      const smsOnlyCatalog = defineTemplates({
        smsOnly: {
          input: z.object({ text: z.string() }),
          kind: 'notification' as const,
          sms: ({ text }: { text: string }) => text,
        },
      });

      expect(() => render(smsOnlyCatalog.smsOnly, 'email', { text: 'hi' }, 'en')).toThrow(/channel "email" is not defined/i);
    });

    it('definedChannels identifies email channel correctly', () => {
      expect(definedChannels(emailCatalog.orderWithHtml)).toEqual(['whatsapp', 'sms', 'email']);
      expect(definedChannels(emailCatalog.emailOnlyNotification)).toEqual(['email']);
    });
  });

  describe('Console provider delivery', () => {
    it('sends through console provider as a chain channel with correct subject and text', async () => {
      const emailConsole = consoleProvider<RenderedEmail>({ channel: 'email', name: 'console-email' });
      const emailSpy = spyOn(emailConsole, 'send');
      const silenced = captureConsole(['log']);

      try {
        const messaging = createMessaging(newEnv(), {
          templates: emailCatalog,
          providers: () => ({ email: emailConsole }),
          delivery: { fallback: ['email'], always: [] },
        });

        const { id } = await messaging.send({
          template: 'orderTextOnly',
          to: TO,
          email: EMAIL,
          locale: 'en',
          input: { name: 'Ann', orderId: 'ORD-100' },
        });

        expect(emailSpy).toHaveBeenCalledTimes(1);
        const sendPayload = emailSpy.mock.calls[0][0];
        expect(sendPayload.to).toBe(EMAIL);
        expect(sendPayload.messageId).toBe(id);
        expect(sendPayload.subject).toBe('Order ORD-100 update');
        expect(sendPayload.text).toBe('Hi Ann, your order ORD-100 status updated.');
        expect('html' in sendPayload).toBe(false);

        const record = await messaging.status(id);
        expect(record).not.toBeNull();
        expect(record!.policy).toEqual({ fallback: ['email'], always: [] });
        expect(record!.chain.attempts).toHaveLength(1);
        expect(record!.chain.attempts[0]).toMatchObject({
          channel: 'email',
          provider: 'console-email',
          status: 'sent',
        });
        expect(record!.status).toBe('sent');
      } finally {
        silenced.restore();
      }
    });

    it('sends through console provider as an always channel with correct subject, text, and html', async () => {
      const wa = recordingProvider<RenderedWhatsApp>('whatsapp', 'rec-wa', [{ ok: true, providerId: 'wa-123' }]);
      const emailConsole = consoleProvider<RenderedEmail>({ channel: 'email', name: 'console-email' });
      const emailSpy = spyOn(emailConsole, 'send');
      const silenced = captureConsole(['log']);

      try {
        const messaging = createMessaging(newEnv(), {
          templates: emailCatalog,
          providers: () => ({ whatsapp: wa, email: emailConsole }),
          delivery: { fallback: ['whatsapp'], always: ['email'] },
        });

        const { id } = await messaging.send({
          template: 'orderWithHtml',
          to: TO,
          email: EMAIL,
          locale: 'en',
          input: { name: 'Bob', orderId: 'ORD-200' },
        });

        expect(wa.calls).toHaveLength(1);
        expect(emailSpy).toHaveBeenCalledTimes(1);

        const emailPayload = emailSpy.mock.calls[0][0];
        expect(emailPayload.to).toBe(EMAIL);
        expect(emailPayload.messageId).toBe(id);
        expect(emailPayload.subject).toBe('[en] Order ORD-200 shipped');
        expect(emailPayload.text).toBe('Hi Bob, your order ORD-200 is on its way.');
        expect(emailPayload.html).toBe('<h1>Hi Bob</h1><p>Your order <strong>ORD-200</strong> is on its way.</p>');

        const record = await messaging.status(id);
        expect(record).not.toBeNull();
        expect(record!.chain.attempts[0]).toMatchObject({
          channel: 'whatsapp',
          provider: 'rec-wa',
          status: 'sent',
        });
        expect(record!.always).toHaveLength(1);
        expect(record!.always[0]).toMatchObject({
          channel: 'email',
          provider: 'console-email',
          status: 'sent',
        });
        expect(record!.status).toBe('sent');
      } finally {
        silenced.restore();
      }
    });
  });

  describe('Skipping email when no email address is present', () => {
    it('skips email when in always, logs send.channel-skipped, and still sends phone channel', async () => {
      const wa = recordingProvider<RenderedWhatsApp>('whatsapp', 'rec-wa', [{ ok: true, providerId: 'wa-pid' }]);
      const email = recordingProvider<RenderedEmail>('email', 'rec-email');

      const capturedConsole = captureConsole(['log', 'info', 'warn', 'error']);

      try {
        const messaging = createMessaging(newEnv(), {
          templates: emailCatalog,
          providers: () => ({ whatsapp: wa, email }),
          delivery: { fallback: ['whatsapp'], always: ['email'] },
        });

        // Send without `email` property
        const { id } = await messaging.send({
          template: 'orderWithHtml',
          to: TO,
          locale: 'en',
          input: { name: 'Charlie', orderId: 'ORD-300' },
        });

        // Phone channel was sent
        expect(wa.calls).toHaveLength(1);
        expect(wa.calls[0].to).toBe(TO);

        // Email channel was skipped
        expect(email.calls).toHaveLength(0);

        // Check console logs for structured send.channel-skipped
        const logLines = capturedConsole.logs;
        const skippedLog = logLines
          .map((line) => {
            try {
              return JSON.parse(line) as { event?: string; channel?: string; id?: string };
            } catch {
              return null;
            }
          })
          .find((record) => record?.event === 'send.channel-skipped');

        expect(skippedLog).toBeDefined();
        expect(skippedLog?.channel).toBe('email');
        expect(skippedLog?.id).toBe(id);

        // Check status record
        const record = await messaging.status(id);
        expect(record).not.toBeNull();
        expect(record!.policy).toEqual({ fallback: ['whatsapp'], always: [] });
        expect(record!.always).toHaveLength(0);
        expect(record!.chain.attempts).toHaveLength(1);
        expect(record!.chain.attempts[0].channel).toBe('whatsapp');
        expect(record!.status).toBe('sent');
      } finally {
        capturedConsole.restore();
      }
    });

    it('skips email when in fallback chain, logs send.channel-skipped, and falls back to sms', async () => {
      const email = recordingProvider<RenderedEmail>('email', 'rec-email');
      const sms = recordingProvider<RenderedSms>('sms', 'rec-sms', [{ ok: true, providerId: 'sms-pid' }]);
      const capturedConsole = captureConsole(['log', 'info', 'warn', 'error']);

      try {
        const messaging = createMessaging(newEnv(), {
          templates: emailCatalog,
          providers: () => ({ email, sms }),
          delivery: { fallback: ['email', 'sms'], always: [] },
        });

        // Send without `email` property
        const { id } = await messaging.send({
          template: 'orderWithHtml',
          to: TO,
          locale: 'en',
          input: { name: 'Dana', orderId: 'ORD-400' },
        });

        // Email was skipped, sms was sent
        expect(email.calls).toHaveLength(0);
        expect(sms.calls).toHaveLength(1);
        expect(sms.calls[0].to).toBe(TO);

        // Check logged event
        const skippedLog = capturedConsole.logs
          .map((line) => {
            try {
              return JSON.parse(line) as { event?: string; channel?: string; id?: string };
            } catch {
              return null;
            }
          })
          .find((record) => record?.event === 'send.channel-skipped');

        expect(skippedLog).toBeDefined();
        expect(skippedLog?.channel).toBe('email');
        expect(skippedLog?.id).toBe(id);

        // Check status record
        const record = await messaging.status(id);
        expect(record).not.toBeNull();
        expect(record!.policy).toEqual({ fallback: ['sms'], always: [] });
        expect(record!.chain.attempts).toHaveLength(1);
        expect(record!.chain.attempts[0].channel).toBe('sms');
        expect(record!.status).toBe('sent');
      } finally {
        capturedConsole.restore();
      }
    });

    it('skips email when email field is empty or whitespace string', async () => {
      const wa = recordingProvider<RenderedWhatsApp>('whatsapp', 'rec-wa', [{ ok: true }]);
      const email = recordingProvider<RenderedEmail>('email', 'rec-email');
      const capturedConsole = captureConsole(['log', 'info', 'warn', 'error']);

      try {
        const messaging = createMessaging(newEnv(), {
          templates: emailCatalog,
          providers: () => ({ whatsapp: wa, email }),
          delivery: { fallback: ['whatsapp'], always: ['email'] },
        });

        const { id } = await messaging.send({
          template: 'orderTextOnly',
          to: TO,
          email: ' '.repeat(3),
          locale: 'en',
          input: { name: 'Eve', orderId: 'ORD-500' },
        });

        expect(wa.calls).toHaveLength(1);
        expect(email.calls).toHaveLength(0);

        const record = await messaging.status(id);
        expect(record!.policy).toEqual({ fallback: ['whatsapp'], always: [] });
        expect(record!.always).toHaveLength(0);
      } finally {
        capturedConsole.restore();
      }
    });
  });

  describe('Participation in policy', () => {
    it('email participates only when resolved policy lists it and is never added implicitly', async () => {
      const wa = recordingProvider<RenderedWhatsApp>('whatsapp', 'rec-wa', [{ ok: true }]);
      const sms = recordingProvider<RenderedSms>('sms', 'rec-sms', [{ ok: true }]);
      const email = recordingProvider<RenderedEmail>('email', 'rec-email', [{ ok: true }]);

      const messaging = createMessaging(newEnv(), {
        templates: emailCatalog,
        providers: () => ({ whatsapp: wa, sms, email }),
        // Default policy is whatsapp -> sms, no always
        delivery: { fallback: ['whatsapp', 'sms'], always: [] },
      });

      // Send with email provided, but policy does not list email
      const { id } = await messaging.send({
        template: 'orderWithHtml',
        to: TO,
        email: EMAIL,
        locale: 'en',
        input: { name: 'Frank', orderId: 'ORD-600' },
      });

      expect(wa.calls).toHaveLength(1);
      expect(sms.calls).toHaveLength(0);
      expect(email.calls).toHaveLength(0);

      const record = await messaging.status(id);
      expect(record!.policy).toEqual({ fallback: ['whatsapp', 'sms'], always: [] });
      expect(record!.always).toHaveLength(0);
    });
  });

  describe('email recipient validation (header injection)', () => {
    // `email` becomes the To: header of a MIME message. Validating it here, at the one door it
    // comes in through, covers every email provider rather than each provider's own builder.
    it.each([
      ['a CRLF injecting Bcc', 'victim@example.com\r\nBcc: attacker@evil.example'],
      ['a bare LF', 'victim@example.com\nBcc: attacker@evil.example'],
      ['a bare CR', 'victim@example.com\rBcc: attacker@evil.example'],
      ['an address list', 'victim@example.com, attacker@evil.example'],
      ['a display name', 'Victim <victim@example.com>'],
      ['no domain', 'victim'],
      ['no local part', '@example.com'],
    ])('rejects %s before any provider is called', async (_label, email) => {
      const messaging = messagingWithEmail();

      let caught: unknown;
      try {
        await messaging.send({
          template: 'orderWithHtml',
          to: TO,
          email,
          locale: 'en',
          input: { name: 'Mallory', orderId: 'ORD-700' },
        });
      } catch (error) {
        caught = error;
      }

      expect((caught as Error | undefined)?.name).toBe('EmailRecipientError');
    });

    it('accepts an ordinary address and a plus-addressed one', async () => {
      for (const email of ['alice@example.com', 'alice+tag@mail.example.co.uk']) {
        const messaging = messagingWithEmail();
        const { id } = await messaging.send({
          template: 'orderWithHtml',
          to: TO,
          email,
          locale: 'en',
          input: { name: 'Alice', orderId: 'ORD-701' },
        });
        const record = await messaging.status(id);
        expect(record!.always[0]).toMatchObject({ channel: 'email', status: 'sent' });
      }
    });
  });
});
