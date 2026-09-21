/**
 * Basic example Worker using messagefall-workers with console providers.
 *
 * Runs locally without vendor credentials, exports FallbackTimer for timed fallback,
 * and mounts createMessagingApp at top-level module scope.
 *
 * @module
 */

import { type MessagingEnv } from 'messagefall-workers';
import { createMessagingApp } from 'messagefall-workers/app';
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
    // The package defaults, stated explicitly so the example shows where they live. These are
    // the values anyone copying this quick start wants. Tests that need the alarm to fire
    // quickly point the harness at their own entrypoint instead of shrinking these.
    timeout: { otp: 30_000, notification: 300_000 },
  },
});

export default app;
