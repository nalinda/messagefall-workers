/**
 * Test helpers and type mirrors for Hono application specifications (Issue #13).
 *
 * @module
 */

import type { Hono } from 'hono';

import type { MessagingOptions } from '../../src/core/messaging.js';
import type { MessagingEnv } from './env.js';

/**
 * createMessagingApp function signature.
 */
export type CreateMessagingAppFn = <E extends MessagingEnv = MessagingEnv>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: MessagingOptions<any> & { basePath?: string }
) => Hono<{ Bindings: E }>;

/**
 * Dynamically loads createMessagingApp from src/app/hono.js if implemented, or falls back to
 * src/index.js stubs so tests execute real assertions and fail for the right reason.
 */
export async function loadCreateMessagingApp(): Promise<CreateMessagingAppFn> {
  try {
    const honoModule = '../../src/app/hono.js';
    const mod = (await import(honoModule)) as unknown as {
      createMessagingApp?: CreateMessagingAppFn;
    };
    if (typeof mod.createMessagingApp === 'function') {
      return mod.createMessagingApp;
    }
  } catch {
    // hono.js not yet implemented (RED phase)
  }

  try {
    const rootModule = '../../src/index.js';
    const root = (await import(rootModule)) as unknown as {
      createMessagingApp?: CreateMessagingAppFn;
    };
    if (typeof root.createMessagingApp === 'function') {
      return root.createMessagingApp;
    }
  } catch {
    // index.js does not export createMessagingApp yet
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((_options: MessagingOptions<any> & { basePath?: string }) => {
    return {
      fetch: () => new Response('Not Implemented', { status: 501 }),
    } as unknown as Hono<{ Bindings: MessagingEnv }>;
  }) as CreateMessagingAppFn;
}
