/**
 * Core messaging types for messagefall-workers.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import type { DeliveryOverride, DeliveryPolicy } from './core/policy.js';
import type { Channel, DeliveryStatus, Provider } from './providers/types.js';
import type { TemplateDef } from './templates.js';

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

/**
 * Message status details.
 */
export interface MessageStatus {
  id: string;
  status: DeliveryStatus;
  timestamp?: Date;
  provider?: string;
  details?: Record<string, unknown>;
}

/**
 * Message state stored in KV.
 */
export interface MessageState {
  id: string;
  kind: TemplateKind;
  channel: Channel;
  status: DeliveryStatus;
  statusTimestamp: Date;
  templateId: string;
  createdAt: Date;
}

/**
 * Message status entry stored in KV.
 */
export interface MessageStatusEntry {
  id: string;
  status: DeliveryStatus;
  timestamp: Date;
}

/**
 * Base environment bindings for messaging.
 */
export interface MessagingEnv {
  MESSAGES_KV?: KVNamespace;
  FALLBACK_TIMER?: unknown;
  [key: string]: unknown;
}

/**
 * Messaging configuration options.
 */
export interface MessagingConfig<Env = MessagingEnv> {
  kv?: KVNamespace;
  timer?: unknown;
  durable?: {
    class: unknown;
    id: string | number;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  templates?: Record<string, TemplateDef<any>>;
  providers?:
    | ((env: Env) => Record<string, Provider>)
    | Provider[]
    | {
        id: string;
        config: Record<string, unknown>;
        state?: unknown;
      }[];
  delivery?: DeliveryOverride;
  deliveryPolicy?: DeliveryOverride;
  fallbackTimeoutMs?: number;
  statusTtl?: number;
  onStatus?: (event: unknown) => void | Promise<void>;
  basePath?: string;
  env?: Env;
}

/**
 * Messaging state.
 */
export interface MessagingState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  templates: Map<string, TemplateDef<any>>;
  queue: Map<string, MessageState[]>;
  store: Map<string, MessageStatusEntry[]>;
  providers: Map<string, Provider>;
  policy: DeliveryPolicy;
  fallbackTimeout: number;
  ctx?: { waitUntil: (reason: Promise<unknown>) => void };
}
