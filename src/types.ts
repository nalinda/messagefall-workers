/**
 * Core messaging types.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import type { Hono } from 'hono';

/**
 * Template kind.
 */
export type TemplateKind = 'otp' | 'text';

/**
 * Message type.
 */
export type MessageType = TemplateKind;

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
 * Standard Schema for template inputs and renderings.
 *
 * This is a simplified version - in reality you'd use `zod` StandardSchema.
 */
export type StandardSchema<T extends Record<string, unknown>> = T;

/**
 * Template rendering configuration per channel.
 */
export interface TemplateRendering {
  /**
   * Channel this rendering applies to.
   */
  channel: Channel;
  /**
   * Channel-specific rendering options.
   */
  options: Record<string, string>;
  /**
   * Meta WhatsApp template name for WhatsApp channel.
   */
  name?: string;
  /**
   * Meta WhatsApp component parameters for the template.
   */
  params?: Record<string, unknown>;
}

/**
 * Template definition.
 */
export interface TemplateDefinition {
  /**
   * Template identifier.
   */
  id: string;
  /**
   * Template kind.
   */
  kind: TemplateKind;
  /**
   * Input schema for validating send inputs.
   */
  inputSchema: StandardSchema<Record<string, unknown>>;
  /**
   * Renderings per channel.
   */
  renderings: TemplateRendering[];
  /**
   * Default delivery policy.
   */
  deliveryPolicy?: DeliveryPolicy;
}

/**
 * Delivery policy configuration.
 */
export interface DeliveryPolicy {
  /**
   * Whether fallback chain is enabled.
   */
  fallbackChain?: boolean;
  /**
   * Channels to always send to (parallel to fallback).
   */
  alwaysOnChannels?: Channel[];
  /**
   * Fallback chain overrides.
   */
  fallbacks?: {
    from: Channel;
    to: Channel;
    timeoutMs: number;
    thresholdStatuses?: DeliveryStatus[];
  }[];
}

/**
 * Messaging configuration.
 */
export interface MessagingConfig {
  /**
   * KV namespace for storing message state and delivery status.
   */
  kv: KVNamespace;
  /**
   * Durable Object for timed fallback.
   */
  durable?: {
    class: any;
    id: string | number;
  };
  /**
   * Default fallback timeout in milliseconds.
   */
  fallbackTimeoutMs?: number;
  /**
   * Default delivery policy.
   */
  deliveryPolicy?: DeliveryPolicy;
  /**
   * Registered providers.
   */
  providers: {
    id: string;
    config: unknown;
    state: any;
  }[];
}

/**
 * Message status.
 */
export type MessageStatus =
  | { status: 'sent'; timestamp: Date }
  | { status: 'pending'; timeoutMs: number }
  | { status: 'delivered'; timestamp: Date; provider?: string }
  | { status: 'failed'; error: string; timestamp: Date }
  | { status: 'unknown'; message?: string };

/**
 * Message state.
 */
export interface MessageState {
  /**
   * Message ID.
   */
  id: string;
  /**
   * Message kind.
   */
  kind: MessageType;
  /**
   * Channel to send to.
   */
  channel: Channel;
  /**
   * Current status.
   */
  status: DeliveryStatus;
  /**
   * Status timestamp.
   */
  statusTimestamp: Date;
  /**
   * Template ID.
   */
  templateId: string;
  /**
   * When this message was queued.
   */
  createdAt: Date;
}

/**
 * Message status entry for KV storage.
 */
export interface MessageStatusEntry {
  id: string;
  status: DeliveryStatus;
  statusTimestamp: Date;
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
 * Send options.
 */
export interface SendOptions {
  /**
   * Channel to send to. Use 'all' to send to all configured channels.
   */
  channel: Channel | 'all';
  /**
   * Template input data.
   */
  input: unknown;
  /**
   * Override delivery policy for this send.
   */
  policy?: DeliveryPolicy;
  /**
   * Skip confirmation if true.
   */
  skipConfirmation?: boolean;
}

/**
 * Message class for creating typed messages.
 */
export class Message<T extends Record<string, unknown> = Record<string, unknown>> {
  private readonly template: TemplateDefinition;
  private readonly input: T;
  private readonly kind: TemplateKind;
  private readonly policy: DeliveryPolicy;

  constructor(
    templateId: string,
    input: T,
    policy: DeliveryPolicy = {},
  ) {
    const registryEntry = getRegistryEntry(templateId);
    if (!registryEntry) {
      throw new Error(`Unknown template: ${templateId}`);
    }

    // Validate input against template schema
    const validate = registryEntry.inputSchema?.parse;
    if (validate) {
      this.input = validate(input);
    } else {
      this.input = input;
    }

    this.template = registryEntry;
    this.policy = policy;
    this.kind = registryEntry.kind;
  }

  /**
   * Get template kind.
   */
  getKind(): TemplateKind {
    return this.kind;
  }

  /**
   * Get template ID.
   */
  getTemplateId(): string {
    return this.template.id;
  }

  /**
   * Get delivery policy.
   */
  getPolicy(): DeliveryPolicy {
    return this.policy;
  }

  /**
   * Render for a specific channel.
   */
  render(channel: Channel): string {
    const rendering = this.template.renderings.find((r) => r.channel === channel);
    if (!rendering) {
      throw new Error(`No rendering defined for channel: ${channel}`);
    }
    return renderTemplate(rendering, this.input);
  }

  /**
   * Get renderings for all configured channels.
   */
  renderAll(channels: Channel[]): Record<Channel, string> {
    const result: Record<Channel, string> = {};
    for (const channel of channels) {
      result[channel] = this.render(channel);
    }
    return result;
  }
}

/**
 * Render a template rendering to a string.
 */
function renderTemplate(rendering: TemplateRendering, input: Record<string, unknown>): string {
  // Default handler - simple string interpolation
  if (rendering.options.format === 'text') {
    return formatText(rendering.options.text, input);
  }

  // Channel-specific handlers
  switch (rendering.channel) {
    case 'whatsapp': {
      return renderWhatsApp(rendering, input);
    }
    case 'sms': {
      return renderSMS(rendering, input);
    }
    case 'email': {
      return renderEmail(rendering, input);
    }
  }
}

/**
 * Format text template with simple interpolation.
 */
function formatText(text: string, input: Record<string, unknown>): string {
  return text.replace(/:(\w+)/g, (match, key) => {
    if (key in input) {
      return String(input[key]);
    }
    return match;
  });
}

/**
 * Render WhatsApp template.
 */
function renderWhatsApp(
  rendering: TemplateRendering & { channel: 'whatsapp' },
  input: Record<string, unknown>,
): string {
  const { name, params, options } = rendering;

  if (name) {
    // Meta WhatsApp template with components
    return generateWhatsAppTemplate(name, input, params, options);
  }

  // Plain text WhatsApp message
  return formatText(options.text, input);
}

function generateWhatsAppTemplate(
  name: string,
  input: Record<string, unknown>,
  params: Record<string, unknown> | undefined,
  options: Record<string, string>,
): string {
  // This is a simplified version - real implementation would use
  // https://developers.facebook.com/docs/whatsapp/business-api/template
  const text = formatText(options.text, input);
  return `Template: ${name}\nBody: ${text}`;
}

/**
 * Render SMS template.
 */
function renderSMS(
  rendering: TemplateRendering & { channel: 'sms' },
  input: Record<string, unknown>,
): string {
  const { options } = rendering;
  return formatText(options.text, input);
}

/**
 * Render email template.
 */
function renderEmail(
  rendering: TemplateRendering & { channel: 'email' },
  input: Record<string, unknown>,
): string {
  const { options } = rendering;
  return formatText(options.text, input);
}

/**
 * Get template registry entry.
 *
 * In production, this would look up the template in a database or KV.
 */
function getRegistryEntry(id: string): TemplateRegistryEntry | undefined {
  // TODO: Implement lookup from storage
  return {
    id,
    kind: 'text' as const,
    inputSchema: { type: 'object' as const, shape: {} },
    renderings: [
      { channel: 'whatsapp', options: { text: '' } },
      { channel: 'sms', options: { text: '' } },
      { channel: 'email', options: { text: '' } },
    ],
  };
}

/**
 * Messaging state interface.
 */
export interface MessagingState {
  /**
   * Template registry.
   */
  templates: Map<string, TemplateRegistryEntry>;
  /**
   * Queue of messages being processed.
   */
  queue: Map<string, MessageState[]>;
  /**
   * Delivery status store.
   */
  store: Map<string, Map<string, MessageStatusEntry[]>>;
  /**
   * Provider registry.
   */
  providers: Map<string, any>;
}

/**
 * Messaging instance.
 */
export interface MessagingState extends MessagingState {
  /**
   * Default delivery policy.
   */
  policy: DeliveryPolicy;
  /**
   * Fallback timeout.
   */
  fallbackTimeout: number;
  /**
   * ExecutionContext for scheduling.
   */
  ctx?: { waitUntil: (reason: Promise<any>) => void };
}

/**
 * Messaging handler interface.
 */
export interface MessagingHandler {
  /**
   * Send handler.
   */
  send: (options: SendOptions) => Promise<{
    messageId: string;
    status: Promise<MessageStatus>;
  }>;
  /**
   * Route handler.
   */
  route: (channel: Channel, input: unknown) => Promise<MessageStatus>;
  /**
   * Webhook handlers for each provider.
   */
  webhooks: { [provider: string]: (request: Request) => Response };
}

/**
 * Handler context.
 */
export interface MessagingHandlerCtx {
  request: Request;
  executionContext?: { waitUntil: (reason: Promise<any>) => void };
}

/**
 * Provider interface.
 */
export interface Provider {
  readonly id: string;
  readonly channel: Channel;
  send(options: {
    config: any;
    channel: Channel;
    template: TemplateDefinition;
    input: unknown;
    policy?: DeliveryPolicy;
  }): Promise<{
    messageId: string;
    status: Promise<ProviderStatus>;
  }>;
  status?(messageId: string): Promise<ProviderStatus>;
  statusHandler?(request: Request): Response;
}
