/**
 * Core messaging types for messagefall-workers.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

/**
 * Supported message delivery channels.
 */
export type Channel = 'whatsapp' | 'sms' | 'email';

/**
 * Array of all supported channels.
 */
export const CHANNELS = ['whatsapp', 'sms', 'email'] as const;

/**
 * Message delivery status.
 */
export type DeliveryStatus =
  'sent' | 'delivered' | 'read' | 'failed' | 'undelivered' | 'undecipherable' | 'unknown';

/**
 * Template kind: 'otp' for one-time codes, 'notification' for general alerts.
 */
export type TemplateKind = 'otp' | 'notification' | 'text';

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

/**
 * Template rendering definition per channel.
 */
export interface TemplateRendering {
  channel: Channel;
  options?: Record<string, string>;
  template?: string;
  language?: string | Record<string, string>;
  params?: (input: unknown) => unknown[];
  text?: string | ((input: unknown, locale?: string) => string);
  subject?: (input: unknown, locale?: string) => string;
  html?: (input: unknown, locale?: string) => string;
}

import type { DeliveryOverride, DeliveryPolicy } from './core/policy.js';

export type { DeliveryOverride, DeliveryPolicy, ResolveDeliveryArgs } from './core/policy.js';
export { DEFAULT_POLICY, PolicyError, resolveDelivery } from './core/policy.js';

/**
 * Template definition in a template catalog.
 */
export interface TemplateDefinition<TInput = never> {
  id?: string;
  kind: TemplateKind;
  input?: StandardSchemaV1<TInput>;
  inputSchema?: unknown;
  whatsapp?: {
    template?: string;
    language?: string | Record<string, string>;
    params?: (input: TInput) => unknown[];
    text?: string | ((input: TInput) => string);
  };
  sms?: string | ((input: TInput, locale?: string) => string);
  email?: {
    subject?: (input: TInput, locale?: string) => string;
    text?: (input: TInput, locale?: string) => string;
    html?: (input: TInput, locale?: string) => string;
  };
  delivery?: DeliveryOverride;
  renderings?: TemplateRendering[];
}

/**
 * Catalog of templates.
 */
export type TemplateCatalog = Record<string, TemplateDefinition<never>>;

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
 * Status event from webhooks.
 */
export interface StatusEvent {
  providerId: string;
  status: DeliveryStatus;
  error?: string;
  at?: Date | string;
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
 * Provider interface.
 */
export interface Provider {
  readonly id?: string;
  readonly name?: string;
  readonly channel: Channel;
  send(options: unknown): Promise<{
    ok?: boolean;
    messageId?: string;
    providerId?: string;
    status?: Promise<MessageStatus>;
    error?: string;
    retryable?: boolean;
  }>;
  status?(messageId: string): Promise<MessageStatus>;
  webhook?: {
    verify?(request: Request): Promise<Response | null>;
    parse(request: Request): Promise<StatusEvent[]>;
  };
  statusHandler?(request: Request): Promise<Response> | Response;
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
  templates?: TemplateCatalog;
  providers?:
    | ((env: Env) => Record<string, Provider>)
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
}

/**
 * Messaging state.
 */
export interface MessagingState {
  templates: Map<string, TemplateDefinition>;
  queue: Map<string, MessageState[]>;
  store: Map<string, MessageStatusEntry[]>;
  providers: Map<string, Provider>;
  policy: DeliveryPolicy;
  fallbackTimeout: number;
  ctx?: { waitUntil: (reason: Promise<unknown>) => void };
}
