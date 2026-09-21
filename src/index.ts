/**
 * messagefall-workers
 *
 * Outbound messaging for Cloudflare Workers: WhatsApp first with SMS fallback,
 * email, typed templates, delivery-status webhooks, and a client for Worker-to-Worker sends.
 *
 * The ready-made Hono app is NOT re-exported here: it lives behind its own
 * `messagefall-workers/app` entry point. `hono` is an optional peer dependency, so a static
 * re-export from this barrel would make `import 'messagefall-workers'` fail at module
 * resolution for every consumer that has not installed it — taking `createMessaging`,
 * `defineTemplates` and every type down with it. Keeping the app off the root barrel makes
 * that failure mode impossible by construction.
 *
 * @module
 */

export * from './core/fallback.js';
export * from './core/logger.js';
export {
  createMessaging,
  E164,
  type Messaging,
  MessagingConfigError,
  type MessagingOptions,
  ProviderConfigError,
  type ProviderSet,
  RecipientError,
  type SendArgs,
  type SendContext,
  type StatusCallbackEvent,
  UnknownTemplateError,
} from './core/messaging.js';
export * from './core/policy.js';
export * from './core/redact.js';
export * from './core/status.js';
export { armTimer, type ArmTimerArgs, cancelTimer } from './core/timer.js';
export * from './core/webhook.js';
export * from './env.js';
export * from './providers/index.js';
export * from './templates.js';
export * from './types.js';
