/**
 * Core messaging types for messagefall-workers.
 *
 * Re-exported wholesale by the root barrel, so this file is the public API's own surface: the
 * types below — each list one sub-issue's documented interface — and, through the re-exports at
 * the end of the file, the runtime entry points that go with them (`advanceChain`,
 * `resolveDelivery`, `kvStatusStore`, `handleWebhook`, `validateEnv`, `defineTemplates`,
 * `render`, …). Despite the file's name this is where to look for what a consumer can reach, not
 * only in the module that defines a symbol. Derivations the core shares between
 * its own modules — `chainStatus`, `deriveOverallStatus`, `createWebhookHandler`,
 * `applyStatusEvents`, `renderValidated`, the redaction engine — are deliberately absent. They
 * are imported by relative path inside `src/`, which is what an internal seam looks like here.
 *
 * @module
 */

/**
 * Issue reported by standard schema validation.
 */
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

/**
 * Result of standard schema validation.
 */
export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaIssue> };

/**
 * Standard Schema specification interface (types only, no runtime dependency).
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
  };
}

export type { AdvanceChainArgs } from './core/fallback.js';
export { advanceChain } from './core/fallback.js';
export type { DeliveryOverride, DeliveryPolicy, ResolveDeliveryArgs } from './core/policy.js';
export { DEFAULT_POLICY, PolicyError, resolveDelivery } from './core/policy.js';
export type {
  Attempt,
  MessageRecord,
  ProviderRef,
  StatusStore,
  StatusStoreOptions,
} from './core/status.js';
export { DEFAULT_STATUS_TTL, kvStatusStore, MessageRecordNotFoundError } from './core/status.js';
export type { StatusApplied, WebhookDispatchOptions, WebhookHandler } from './core/webhook.js';
export { handleWebhook } from './core/webhook.js';
export type { MessagingEnv } from './env.js';
export { validateEnv } from './env.js';
export type {
  Channel,
  DeliveryStatus,
  OutboundMeta,
  Provider,
  RenderedEmail,
  RenderedSms,
  RenderedWhatsApp,
  SendResult,
  StatusEvent,
  TemplateKind,
} from './providers/types.js';
export { CHANNELS } from './providers/types.js';
export type {
  AnyRendered,
  EmailTemplateConfig,
  InputOf,
  Locale,
  TemplateDef,
  Templates,
  WhatsAppTemplateConfig,
} from './templates.js';
export { definedChannels, defineTemplates, render, TemplateValidationError } from './templates.js';
