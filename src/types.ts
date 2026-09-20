/**
 * Core messaging types for messagefall-workers.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

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
} from './providers/types.js';
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

/**
 * Array of all supported channels.
 */
export const CHANNELS = ['whatsapp', 'sms', 'email'] as const;

/**
 * Template kind: 'otp' for one-time codes, 'notification' for general alerts.
 */
export type TemplateKind = 'otp' | 'notification';

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

export type { DeliveryOverride, DeliveryPolicy, ResolveDeliveryArgs } from './core/policy.js';
export { DEFAULT_POLICY, PolicyError, resolveDelivery } from './core/policy.js';
export type {
  Attempt,
  MessageRecord,
  ProviderRef,
  StatusStore,
  StatusStoreOptions,
} from './core/status.js';
export { DEFAULT_STATUS_TTL, deriveOverallStatus, kvStatusStore } from './core/status.js';

/**
 * Base environment bindings for messaging.
 */
export interface MessagingEnv {
  MESSAGES_KV?: KVNamespace;
  FALLBACK_TIMER?: unknown;
  [key: string]: unknown;
}
