/**
 * Basic example Worker using messagefall-workers with console providers.
 *
 * Runs locally without vendor credentials, exports FallbackTimer for timed fallback,
 * and mounts createMessagingApp at top-level module scope.
 *
 * @module
 */

import { createMessagingApp, type MessagingEnv } from 'messagefall-workers';
import { consoleProvider } from 'messagefall-workers/providers/console';

import { templates } from './templates.js';

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
    timeout: { otp: 25, notification: 25 },
  },
});

export default app;
