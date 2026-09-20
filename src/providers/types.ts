/**
 * Provider contract for messaging providers.
 *
 * @module
 */

import type { Channel, DeliveryPolicy,TemplateDefinition, TemplateRendering } from '../types';

/**
 * Provider configuration.
 */
export interface ProviderConfig {
  /**
   * Provider identifier.
   */
  id: string;
  /**
   * Channel this provider supports.
   */
  channel: Channel;
  /**
   * Provider-specific configuration.
   */
  config: Record<string, unknown>;
}

/**
 * Provider send function signature.
 */
export interface ProviderSendOptions {
  /**
   * Provider configuration.
   */
  config: ProviderConfig;
  /**
   * Channel to send to.
   */
  channel: Channel;
  /**
   * Template definition to render.
   */
  template: TemplateDefinition;
  /**
   * Template input data.
   */
  input: unknown;
  /**
   * Renderings for channels other than the primary one.
   */
  renderings?: TemplateRendering[];
  /**
   * Delivery policy.
   */
  policy?: DeliveryPolicy;
}

/**
 * Provider send function.
 */
export type ProviderSendFn = (options: ProviderSendOptions) => Promise<{
  messageId: string;
  status: Promise<ProviderStatus>;
}>;

/**
 * Provider status function signature.
 */
export type ProviderStatusFn = (
  messageId: string,
) => Promise<ProviderStatus>;

/**
 * Provider status result.
 */
export interface ProviderStatus {
  /**
   * Delivery status from the provider.
   */
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'undelivered' | 'undecipherable' | 'unknown';
  /**
   * Timestamp of the status update.
   */
  timestamp: Date;
  /**
   * Provider-specific details.
   */
  details?: Record<string, unknown>;
}

/**
 * Provider interface.
 */
export interface Provider {
  /**
   * Provider identifier.
   */
  readonly id: string;
  /**
   * Supported channel.
   */
  readonly channel: Channel;
  /**
   * Send a message.
   */
  send(options: ProviderSendOptions): Promise<{
    messageId: string;
    status: Promise<ProviderStatus>;
  }>;
  /**
   * Get delivery status for a message.
   */
  status?(messageId: string): Promise<ProviderStatus>;
  /**
   * Handle delivery status webhooks.
   */
  statusHandler?(request: Request): Response;
}

/**
 * Provider registration interface.
 */
export interface ProviderFactory {
  /**
   * Provider identifier.
   */
  id: string;
  /**
   * Create provider instance from config.
   */
  create(config: ProviderConfig): Provider;
}
