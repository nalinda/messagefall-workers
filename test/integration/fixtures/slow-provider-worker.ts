/**
 * Integration-test entrypoint: the basic example Worker with a WhatsApp provider whose `send`
 * deliberately blocks for a while before resolving.
 *
 * Only the response-time scenario needs this. Every other scenario runs against `examples/basic`
 * itself, whose console providers resolve immediately — so `< 100ms` there would still pass even
 * if the OTP `ctx.waitUntil` deferral regressed and `send` started waiting for delivery before
 * responding. Routing that one scenario through a genuinely slow provider, through the real
 * `wrangler dev` harness, makes the assertion capable of failing: if the deferral broke, the
 * response would take at least `SLOW_SEND_DELAY_MS`, not under 100ms.
 *
 * @module
 */

import { type MessagingEnv, type Provider, type RenderedWhatsApp } from 'messagefall-workers';
import { createMessagingApp } from 'messagefall-workers/app';
import { consoleProvider } from 'messagefall-workers/providers/console';

import { templates } from '../../../examples/basic/src/templates.js';

export { FallbackTimer } from 'messagefall-workers/durable';

/**
 * How long the slow WhatsApp provider blocks before resolving. Comfortably above the 100ms
 * response-time bound this fixture exists to make meaningful, and short enough that the settle
 * poll in the test picks the eventual `sent` attempt up well inside its own deadline.
 *
 * Not exported: wrangler treats every top-level export of a worker entrypoint as a possible
 * handler and refuses to start if one is not a function or `ExportedHandler` (e.g. a plain
 * `number`). The integration test keeps its own copy of this value in lockstep by comment.
 */
const SLOW_SEND_DELAY_MS = 300;

const slowWhatsapp: Provider<RenderedWhatsApp> = {
  name: 'slow-whatsapp',
  channel: 'whatsapp',
  async send(message) {
    await new Promise((resolve) => setTimeout(resolve, SLOW_SEND_DELAY_MS));
    console.log(
      `[slow-whatsapp] [whatsapp] to=${message.to} template=${message.template} messageId=${message.messageId} (after ${SLOW_SEND_DELAY_MS}ms)`
    );
    return { ok: true, providerId: `slow_${message.messageId}` };
  },
};

const app = createMessagingApp<MessagingEnv>({
  templates,
  providers: () => ({
    whatsapp: slowWhatsapp,
    sms: consoleProvider({ channel: 'sms', name: 'console-sms' }),
    email: consoleProvider({ channel: 'email', name: 'console-email' }),
  }),
  delivery: {
    fallback: ['whatsapp', 'sms'],
    always: ['email'],
    timeout: { otp: 30_000, notification: 300_000 },
  },
});

export default app;
