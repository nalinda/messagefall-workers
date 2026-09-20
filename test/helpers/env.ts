/**
 * Test helpers and type mirrors for environment validation specifications (Issue #13).
 *
 * @module
 */

import type { DurableObjectNamespace, KVNamespace } from '@cloudflare/workers-types';

import type { MessagingOptions } from '../../src/core/messaging.js';
import type { Templates } from '../../src/templates.js';

/**
 * Base environment bindings for messaging (Issue #13 interface).
 */
export interface MessagingEnv {
  MESSAGES_KV: KVNamespace;
  FALLBACK_TIMER?: DurableObjectNamespace;
  MESSAGING_DEV_UNSIGNED?: string;
  [key: string]: unknown;
}

/**
 * Startup validation function signature. Throws an Error listing all configuration problems.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ValidateEnvFn = (env: unknown, options: MessagingOptions<any>) => asserts env is MessagingEnv;

/**
 * Dynamically loads validateEnv from src/env.js if implemented, or falls back to
 * a stub so tests execute real assertions and fail for the right reason.
 */
export async function loadValidateEnv(): Promise<ValidateEnvFn> {
  try {
    const envModule = '../../src/env.js';
    const mod = (await import(envModule)) as unknown as { validateEnv?: ValidateEnvFn };
    if (typeof mod.validateEnv === 'function') {
      return mod.validateEnv;
    }
  } catch {
    // env.js not yet implemented (RED phase)
  }

  try {
    const rootModule = '../../src/index.js';
    const root = (await import(rootModule)) as unknown as { validateEnv?: ValidateEnvFn };
    if (typeof root.validateEnv === 'function') {
      return root.validateEnv;
    }
  } catch {
    // index.js does not export validateEnv yet (RED phase)
  }

  // Fallback no-op stub for RED phase: will fail tests that assert validation errors are thrown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((_env: unknown, _options: MessagingOptions<Templates<any>>) => {
    // No-op stub
  }) as ValidateEnvFn;
}
