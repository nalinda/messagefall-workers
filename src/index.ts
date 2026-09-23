/**
 * messagefall-workers
 *
 * Outbound messaging for Cloudflare Workers: WhatsApp first with SMS fallback,
 * email, typed templates, delivery-status webhooks, and a client for Worker-to-Worker sends.
 *
 * Everything this module names is public API for 0.1.0, and nothing else is. `export *` is
 * deliberately not used for the core modules: it publishes whatever a module happens to export,
 * so internals it needs to share with its neighbours — the chain-status derivation, the
 * redaction engine, the template renderer, the webhook dispatcher's innards — became API that
 * could not be changed without a major version. The lists below are each sub-issue's documented
 * interface and nothing more; `./types.js` carries the same policy for the types.
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

export {
  createMessaging,
  E164,
  EmailRecipientError,
  isEmailAddress,
  type Messaging,
  MessagingConfigError,
  type MessagingOptions,
  ProviderConfigError,
  type ProviderSet,
  RecipientError,
  type SendArgs,
  type SendContext,
  type SendOutcome,
  type SendResponse,
  type StatusCallbackEvent,
  UnknownTemplateError,
} from './core/messaging.js';
export { OTP_ERROR_WITHHELD } from './core/redact.js';
export { armTimer, type ArmTimerArgs, cancelTimer } from './core/timer.js';
export * from './providers/index.js';
export * from './types.js';
