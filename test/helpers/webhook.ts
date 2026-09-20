/**
 * Test helpers and type mirrors for Webhook dispatch specifications (Issue #5).
 *
 * @module
 */

import type { ExecutionContext, KVNamespace } from '@cloudflare/workers-types';

import type { StatusStore } from '../../src/core/status.js';
import { createMessaging } from '../../src/index.js';
import type { Channel, Provider, StatusEvent } from '../../src/providers/types.js';
import type { MessagingConfig } from '../../src/types.js';

/**
 * Event emitted when a delivery status update is applied to an attempt.
 * Consumed by fallback handler (#7) and timer cancel path (#8).
 */
export interface StatusApplied {
  /**
   * Internal message identifier.
   */
  id: string;
  /**
   * Delivery channel of the attempt.
   */
  channel: Channel;
  /**
   * Name of the provider handling the attempt.
   */
  provider: string;
  /**
   * Part of the delivery policy ('chain' for fallback chain, 'always' for parallel always-on).
   */
  part: 'chain' | 'always';
  /**
   * Parsed delivery status event.
   */
  event: StatusEvent;
}

/**
 * Webhook dispatch options for testing.
 */
export interface WebhookDispatchOptions {
  providers?: Record<string, Provider> | Provider[];
  kv?: KVNamespace;
  store?: StatusStore;
  onStatus?: (event: unknown) => void | Promise<void>;
  onStatusApplied?: (event: StatusApplied) => void | Promise<void>;
  env?: Record<string, unknown>;
}

/**
 * Webhook handler function signature.
 */
export type WebhookHandler = (
  providerName: string,
  request: Request,
  ctx?: ExecutionContext
) => Promise<Response>;

/**
 * Mock ExecutionContext for verifying ctx.waitUntil usage.
 */
export interface MockExecutionContext {
  waitUntil: (promise: Promise<unknown>) => void;
  passThroughOnException: () => void;
  promises: Promise<unknown>[];
  flush: () => Promise<void>;
}

/**
 * Creates a mock ExecutionContext for testing ctx.waitUntil.
 */
export function createMockExecutionContext(): MockExecutionContext {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    waitUntil(promise: Promise<unknown>): void {
      promises.push(promise);
    },
    passThroughOnException(): void {
      // no-op
    },
    async flush(): Promise<void> {
      await Promise.all(promises);
    },
  };
}

/**
 * Loads the webhook handler from src/core/webhook.js if implemented, or falls back to
 * createMessaging so tests execute real assertions and fail for the right reason.
 */
export async function loadWebhookHandler(
  options: WebhookDispatchOptions
): Promise<WebhookHandler> {
  try {
    const webhookEntry = '../../src/core/webhook.js';
    const mod = (await import(webhookEntry)) as unknown as {
      createWebhookHandler?: (opts: WebhookDispatchOptions) => WebhookHandler;
      handleWebhook?: (
        providerName: string,
        request: Request,
        ctx?: ExecutionContext,
        opts?: WebhookDispatchOptions
      ) => Promise<Response>;
    };

    if (mod.createWebhookHandler) {
      return mod.createWebhookHandler(options);
    }
    if (mod.handleWebhook) {
      return (providerName, request, ctx) =>
        mod.handleWebhook!(providerName, request, ctx, options);
    }
  } catch {
    // webhook.js not yet implemented
  }

  const messaging = createMessaging({
    providers: options.providers as unknown as MessagingConfig['providers'],
    kv: options.kv,
    env: options.env,
    onStatus: options.onStatus,
  });

  return (providerName: string, request: Request, _ctx?: ExecutionContext) =>
    messaging.handleWebhook(providerName, request);
}
