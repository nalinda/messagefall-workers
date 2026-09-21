/**
 * Integration-test entrypoint: the basic example Worker with a deliberately tiny chain timeout.
 *
 * Only the scenario that tests the timer's alarm needs one. The example itself ships realistic
 * defaults (30s / 300s), because an alarm that fires milliseconds after every send would make
 * webhook-driven fallback untestable — the timer would produce the fallback attempt whether or
 * not the webhook path worked at all — and would surprise anyone copying the quick start.
 *
 * @module
 */

import { type MessagingEnv } from 'messagefall-workers';
import { createMessagingApp } from 'messagefall-workers/app';
import { consoleProvider } from 'messagefall-workers/providers/console';

import { templates } from '../../../examples/basic/src/templates.js';

export { FallbackTimer } from 'messagefall-workers/durable';

const app = createMessagingApp<MessagingEnv>({
  templates,
  providers: () => ({
    whatsapp: consoleProvider({ channel: 'whatsapp', name: 'console-whatsapp' }),
    sms: consoleProvider({ channel: 'sms', name: 'console-sms' }),
    email: consoleProvider({ channel: 'email', name: 'console-email' }),
  }),
  delivery: {
    fallback: ['whatsapp', 'sms'],
    always: ['email'],
    timeout: { otp: 250, notification: 250 },
  },
});

export default app;
