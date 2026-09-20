/**
 * Core messaging types.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

/**
 * Template rendering per channel.
 */
export interface TemplateRendering {
  channel: Channel;
  options: Record<string, string>;
  name?: string;
  params?: Record<string, unknown>;
}

/**
 * Template definition.
 */
export interface TemplateDefinition {
  id: string;
  kind: TemplateKind;
  inputSchema: Record<string, unknown>;
  renderings: TemplateRendering[];
  deliveryPolicy?: DeliveryPolicy;
}

/**
 * Delivery policy.
 */
export interface DeliveryPolicy {
  fallbackChain?: boolean;
  alwaysOnChannels?: Channel[];
  fallbacks?: {
    from: Channel;
    to: Channel;
    timeoutMs: number;
    thresholdStatuses?: DeliveryStatus[];
  }[];
}

/**
 * Channel type.
 */
export type Channel = 'whatsapp' | 'sms' | 'email';

/**
 * Delivery status.
 */
export type DeliveryStatus =
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'undelivered'
  | 'undecipherable'
  | 'unknown';

/**
 * Template kind.
 */
export type TemplateKind = 'otp' | 'text';

/**
 * Send options.
 */
export interface SendOptions {
  channel: Channel | 'all';
  input: unknown;
  policy?: DeliveryPolicy;
  skipConfirmation?: boolean;
}

/**
 * Message status.
 */
export interface MessageStatus {
  status: DeliveryStatus;
  timestamp: Date;
  provider?: string;
  details?: Record<string, unknown>;
}

/**
 * Message state.
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
 * Message status entry for KV storage.
 */
export interface MessageStatusEntry {
  id: string;
  status: DeliveryStatus;
  timestamp: Date;
}

/**
 * Template registry entry.
 */
export interface TemplateRegistryEntry {
  id: string;
  kind: TemplateKind;
  renderings: TemplateRendering[];
}

/**
 * Messaging config.
 */
export interface MessagingConfig {
  kv: KVNamespace;
  durable?: {
    class: any;
    id: string | number;
  };
  fallbackTimeoutMs?: number;
  deliveryPolicy?: DeliveryPolicy;
  providers: {
    id: string;
    config: Record<string, unknown>;
    state: any;
  }[];
}

/**
 * Messaging state.
 */
export interface MessagingState {
  templates: Map<string, TemplateDefinition>;
  queue: Map<string, MessageState[]>;
  store: Map<string, MessageStatusEntry[]>;
  providers: Map<string, any>;
  policy: DeliveryPolicy;
  fallbackTimeout: number;
  ctx?: { waitUntil: (reason: Promise<any>) => void };
}

/**
 * Supported channels.
 */
export const CHANNELS = ['whatsapp', 'sms', 'email'] as const;
