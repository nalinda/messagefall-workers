/**
 * Loader and shared fixtures for the meta-whatsapp provider tests (Issue #4).
 */

import { metaWhatsApp } from '../../../src/providers/meta-whatsapp/index.js';
import type { Provider, RenderedWhatsApp } from '../../../src/providers/types.js';

/**
 * Configuration accepted by `metaWhatsApp()` as specified in Issue #4.
 */
export interface MetaWhatsAppConfig {
  token: string;
  phoneNumberId: string;
  appSecret: string;
  verifyToken: string;
  apiVersion?: string;
  name?: string;
}

export type MetaWhatsAppFactory = (config: MetaWhatsAppConfig) => Provider<RenderedWhatsApp>;

/**
 * Load the `metaWhatsApp` factory from `src/providers/meta-whatsapp`.
 *
 * Kept async so the test files' `beforeAll` hooks are unchanged; a broken
 * import now fails with a real module-resolution error.
 */
export function loadMetaWhatsApp(): Promise<MetaWhatsAppFactory> {
  return Promise.resolve(metaWhatsApp);
}

/**
 * Standard configuration used across the meta-whatsapp tests.
 */
export const testConfig: MetaWhatsAppConfig = {
  token: 'EAAB-test-token',
  phoneNumberId: '123456789012345',
  appSecret: 'app-secret-for-tests',
  verifyToken: 'verify-token-for-tests',
};

/**
 * Compute `sha256=<hex>` for `body` with `secret` using Web Crypto, the same
 * way Meta signs `X-Hub-Signature-256`.
 */
export async function signBody(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

/**
 * Await `promise` and return the error it rejected with, or `undefined` if it
 * resolved. Lets a test assert on rejection without `await expect(...).rejects`.
 */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}
