/**
 * Provider types and interfaces.
 *
 * @module
 */

import type {
  Channel,
  DeliveryPolicy,
  DeliveryStatus,
  StatusEvent,
  TemplateDefinition,
} from '../types.js';

export type { Channel, DeliveryPolicy, DeliveryStatus, StatusEvent } from '../types.js';

/**
 * Provider configuration.
 */
export interface ProviderConfig {
  id: string;
  channel: Channel;
  config: Record<string, unknown>;
}

/**
 * Options passed to a provider's send method.
 */
export interface ProviderSendOptions {
  config?: ProviderConfig;
  channel: Channel;
  template: TemplateDefinition;
  input: unknown;
  policy?: DeliveryPolicy;
}

/**
 * Status returned by a provider.
 */
export interface ProviderStatus {
  status: DeliveryStatus;
  timestamp: Date;
  details?: Record<string, unknown>;
}

/**
 * Provider interface contract.
 */
export interface Provider {
  readonly id?: string;
  readonly name?: string;
  readonly channel: Channel;
  send(options: unknown): Promise<{
    ok?: boolean;
    messageId?: string;
    providerId?: string;
    status?: Promise<ProviderStatus>;
    error?: string;
    retryable?: boolean;
  }>;
  status?(messageId: string): Promise<ProviderStatus>;
  webhook?: {
    verify?(request: Request): Promise<Response | null>;
    parse(request: Request): Promise<StatusEvent[]>;
  };
  statusHandler?(request: Request): Promise<Response> | Response;
}

/**
 * Factory for creating provider instances.
 */
export interface ProviderFactory {
  id: string;
  create: (config: unknown) => Provider;
}
